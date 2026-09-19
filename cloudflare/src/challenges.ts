import { poolForVersion, suiteVersion, type SuiteName } from "../../ladder/mod.ts";
import { answerFormat, canonicalAnswer, MAX_ANSWER_LENGTH, scoreAnswer } from "../../ladder/family.ts";
import { b64url, canonical, sha256, verifyActorSignature } from "./protocol.ts";
import type { IssuerIdentity } from "./issuer.ts";

const ATTEST_PROTOCOL = "clankdar-attest-v1";
const GATE_PROTOCOL = "clankdar-gate-v1";
const COMMIT_DOMAIN = "clankdar/attest-seed/v1";
const SUBJECT_DOMAIN = "clankdar/subject/v1";

export interface HostedPolicy {
  id: string;
  suite: Exclude<SuiteName, "agent">;
  cells: string[];
  challenges: number;
  minPass: number;
  ttlSeconds: number;
}

export const HOSTED_POLICIES: Record<string, HostedPolicy> = Object.assign(Object.create(null), {
  "v2-floor-v1": {
    id: "v2-floor-v1", suite: "v2",
    cells: ["arithmetic:t2", "strings:t2", "sequence:t2", "cipher:t2", "ordering:t3", "gridpath:t3", "knights:t3", "registervm:t3"],
    challenges: 4, minPass: 3, ttlSeconds: 120,
  },
  "frontier-floor-v1": {
    id: "frontier-floor-v1", suite: "frontier",
    cells: ["sat:t4", "bitmatrix:t4", "bitcircuit:t4", "knights:t5", "registervm:t5", "cryptarithm:t6", "automata:t6", "sat:t5"],
    challenges: 4, minPass: 3, ttlSeconds: 180,
  },
});

export interface HostedChallenge {
  protocol: typeof ATTEST_PROTOCOL;
  kind: "challenge";
  challengeId: string;
  suiteVersion: string;
  family: string;
  tier: number;
  prompt: string;
  seedCommit: string;
  nonce: string;
  expiresAt: string;
  context?: string;
  subject?: string;
  sessionId: string;
  verifier: { keyId: string; publicKey: string };
}

export interface HostedTicket { challenge: HostedChallenge; seed: number; expected: string }
export interface CheckSessionSecret {
  sessionId: string;
  policy: HostedPolicy;
  issuedAt: string;
  expiresAt: string;
  tickets: HostedTicket[];
  subject?: string;
  context?: string;
  subjectPublicKey?: string;
}
export interface HostedSessionSecret extends CheckSessionSecret { actor: string; campaignId: string; epoch: number }
export interface SubjectProof { publicKey: string; signature: string }
export interface HostedReceipt { protocol: typeof ATTEST_PROTOCOL; payload: string; signature: string }
export interface HostedAdmission { protocol: typeof GATE_PROTOCOL; payload: string; signature: string }

const random = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const randomUint32 = () => new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0);
const randomIndex = (bound: number): number => {
  const ceiling = 0x1_0000_0000 - (0x1_0000_0000 % bound);
  for (;;) { const value = randomUint32(); if (value < ceiling) return value % bound; }
};

const cell = (value: string) => {
  const parsed = /^([a-z0-9]+):t(\d+)$/.exec(value);
  if (!parsed) throw new Error("hosted policy cell is malformed");
  return { family: parsed[1], tier: Number(parsed[2]) };
};

const seedCommit = (challenge: Pick<HostedChallenge, "suiteVersion" | "family" | "tier" | "nonce">, seed: number) =>
  sha256([COMMIT_DOMAIN, challenge.suiteVersion, challenge.family, challenge.tier, challenge.nonce, seed].join("\0"));

/** Environment-neutral gate primitives; scheduling and durable acceptance belong to callers. */
export async function issueCheckSession(opts: {
  policy: HostedPolicy; issuer: IssuerIdentity; now: Date; expiresAt: Date;
  subject?: string; context?: string; subjectPublicKey?: string;
}): Promise<{ secret: CheckSessionSecret; challenges: HostedChallenge[] }> {
  const policy = opts.policy;
  if (policy.challenges < 1 || policy.challenges > 16 || policy.minPass < 1 || policy.minPass > policy.challenges) throw new Error("hosted policy bounds are invalid");
  const version = suiteVersion(policy.suite);
  const pool = poolForVersion(version);
  const sessionId = `gs_${random(9)}`;
  const tickets: HostedTicket[] = [];
  for (let i = 0; i < policy.challenges; i++) {
    const selected = cell(policy.cells[randomIndex(policy.cells.length)]);
    const family = pool.find((candidate) => candidate.name === selected.family && candidate.tiers.includes(selected.tier));
    if (!family) throw new Error("hosted policy names an unknown cell");
    const seed = randomUint32();
    const instance = family.generate(selected.tier, seed);
    const expected = canonicalAnswer(instance.answer, answerFormat(family.name));
    if (expected === null) throw new Error("generated answer is not canonical");
    const challenge: HostedChallenge = {
      protocol: ATTEST_PROTOCOL, kind: "challenge", challengeId: `att_${random(9)}`, suiteVersion: version,
      family: family.name, tier: selected.tier, prompt: instance.prompt, seedCommit: "", nonce: random(12),
      expiresAt: opts.expiresAt.toISOString(), sessionId,
      ...(opts.context !== undefined ? { context: opts.context } : {}),
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
      verifier: { keyId: opts.issuer.keyId, publicKey: opts.issuer.publicKey },
    };
    challenge.seedCommit = await seedCommit(challenge, seed);
    tickets.push({ challenge, seed, expected });
  }
  return {
    secret: { sessionId, policy, issuedAt: opts.now.toISOString(), expiresAt: opts.expiresAt.toISOString(), tickets,
      ...(opts.context !== undefined ? { context: opts.context } : {}),
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
      ...(opts.subjectPublicKey !== undefined ? { subjectPublicKey: opts.subjectPublicKey } : {}) },
    challenges: tickets.map((ticket) => ticket.challenge),
  };
}

export async function verifySessionSubject(session: Pick<CheckSessionSecret, "sessionId" | "subjectPublicKey">, proof?: SubjectProof): Promise<boolean> {
  if (session.subjectPublicKey !== undefined && proof?.publicKey !== session.subjectPublicKey) return false;
  return proof === undefined || await verifyActorSignature(proof.publicKey, [SUBJECT_DOMAIN, session.sessionId, proof.publicKey], proof.signature);
}

export async function submitCheckSession(opts: {
  session: CheckSessionSecret;
  responses: Record<string, string>;
  subjectProof?: SubjectProof;
  issuer: IssuerIdentity;
  now: Date;
}): Promise<{ admission: HostedAdmission; receipts: HostedReceipt[]; passed: number; verdict: boolean }> {
  const { session } = opts;
  if (opts.now.getTime() > Date.parse(session.expiresAt)) throw new Error("session expired");
  if (!await verifySessionSubject(session, opts.subjectProof)) throw new Error("subject proof does not verify");
  const known = new Set(session.tickets.map((ticket) => ticket.challenge.challengeId));
  if (Object.keys(opts.responses).some((id) => !known.has(id))) throw new Error("response names an unknown challenge");
  const receipts: HostedReceipt[] = [];
  let passed = 0;
  for (const ticket of session.tickets) {
    const response = opts.responses[ticket.challenge.challengeId];
    if (await seedCommit(ticket.challenge, ticket.seed) !== ticket.challenge.seedCommit) throw new Error("ticket commitment does not verify");
    const family = poolForVersion(ticket.challenge.suiteVersion).find((candidate) => candidate.name === ticket.challenge.family);
    if (!family) throw new Error("ticket family is unknown");
    const instance = family.generate(ticket.challenge.tier, ticket.seed);
    if (instance.prompt !== ticket.challenge.prompt || canonicalAnswer(instance.answer, answerFormat(family.name)) !== ticket.expected) throw new Error("ticket does not regenerate");
    if (typeof response !== "string" || response.length > MAX_ANSWER_LENGTH || canonicalAnswer(response, answerFormat(ticket.challenge.family)) === null) continue;
    const scored = scoreAnswer(instance.answer, response, answerFormat(ticket.challenge.family));
    const body = {
      kind: "receipt", challenge: ticket.challenge, seed: ticket.seed, expected: ticket.expected, response,
      ...(opts.subjectProof !== undefined ? { subjectProof: opts.subjectProof } : {}),
      verdict: { pass: scored.pass, format: answerFormat(ticket.challenge.family), answeredAt: opts.now.toISOString() },
    };
    const payload = canonical(body);
    receipts.push({ protocol: ATTEST_PROTOCOL, payload, signature: await opts.issuer.sign(payload) });
    if (scored.pass) passed++;
  }
  const verdict = passed >= session.policy.minPass;
  const admissionBody = {
    kind: "admission", sessionId: session.sessionId,
    policy: { suite: session.policy.suite, cells: session.policy.cells, challenges: session.policy.challenges, minPass: session.policy.minPass, ttlSeconds: session.policy.ttlSeconds },
    ...(session.subject !== undefined ? { subject: session.subject } : {}),
    ...(session.context !== undefined ? { context: session.context } : {}),
    challenges: session.tickets.map((ticket) => ticket.challenge), receipts,
    verdict: { pass: verdict, passed, required: session.policy.minPass, decidedAt: opts.now.toISOString() },
  };
  const payload = canonical(admissionBody);
  return { admission: { protocol: GATE_PROTOCOL, payload, signature: await opts.issuer.sign(payload) }, receipts, passed, verdict };
}

/** Legacy campaign tickets and admissions retain their actor-key enforcement and wire bindings. */
export async function issueHostedSession(opts: {
  policy: HostedPolicy; actor: string; campaignId: string; epoch: number; issuer: IssuerIdentity; now: Date; expiresAt: Date;
}): Promise<{ secret: HostedSessionSecret; challenges: HostedChallenge[] }> {
  const issued = await issueCheckSession({ ...opts, subject: opts.actor, context: opts.campaignId });
  return { ...issued, secret: { ...issued.secret, actor: opts.actor, campaignId: opts.campaignId, epoch: opts.epoch } };
}

export async function submitHostedSession(opts: {
  session: HostedSessionSecret; responses: Record<string, string>; subjectProof: SubjectProof;
  actorPublicKey: string; issuer: IssuerIdentity; now: Date;
}): Promise<{ admission: HostedAdmission; receipts: HostedReceipt[]; passed: number; verdict: boolean }> {
  return submitCheckSession({ ...opts, session: { ...opts.session,
    subject: opts.session.actor, context: opts.session.campaignId, subjectPublicKey: opts.actorPublicKey } });
}
