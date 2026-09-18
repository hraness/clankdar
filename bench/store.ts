/**
 * Durable gate ledger: an append-only JSONL log of session issuance and
 * admission decisions. A session's decision (receipts + signed admission) is
 * one appended record, so a crash either records the whole decision or leaves
 * the session open — never half-consumed. The log holds seeds and expected
 * answers until reveal; keep the directory private.
 *
 * Replay on open rebuilds the index: issued sessions, decided sessions, and
 * every minted receipt by challenge id. A torn final line (a partial write
 * from a crash) is dropped; corruption earlier in the log is fatal.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, fsyncSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Admission, GateSession } from "./gate.ts";
import type { Receipt } from "./attest.ts";

const LOG_NAME = "gate-state.jsonl";

interface SessionRecord {
  type: "session";
  session: GateSession;
}

interface DecisionRecord {
  type: "decision";
  sessionId: string;
  admission: Admission;
  receipts: Receipt[];
}

type Record = SessionRecord | DecisionRecord;

export class GateStore {
  private readonly fd: number;
  private readonly sessions = new Map<string, GateSession>();
  private readonly decided = new Set<string>();
  private readonly receiptByChallenge = new Map<string, Receipt>();

  private constructor(fd: number) {
    this.fd = fd;
  }

  /** Open (or create) the ledger in `dir` and replay it. */
  static open(dir: string): GateStore {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, LOG_NAME);
    const store = new GateStore(openSync(path, "a", 0o600));
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter((line) => line.length > 0);
      lines.forEach((line, index) => {
        let record: Record;
        try {
          record = JSON.parse(line) as Record;
        } catch {
          if (index === lines.length - 1) return; // torn tail from a crashed append
          throw new Error(`gate ledger is corrupt at record ${index + 1}`);
        }
        store.replay(record);
      });
    }
    return store;
  }

  private replay(record: Record): void {
    if (record.type === "session") {
      const { session } = record;
      if (!session || typeof session.sessionId !== "string" || this.sessions.has(session.sessionId)) throw new Error("gate ledger has a duplicate or malformed session");
      this.sessions.set(session.sessionId, session);
      return;
    }
    if (record.type === "decision") {
      const { sessionId, receipts } = record;
      if (!this.sessions.has(sessionId) || this.decided.has(sessionId)) throw new Error("gate ledger has a decision for an unknown or decided session");
      this.decided.add(sessionId);
      for (const receipt of receipts ?? []) {
        let challengeId = "";
        try {
          challengeId = (JSON.parse(receipt.payload) as { challenge?: { challengeId?: string } }).challenge?.challengeId ?? "";
        } catch {
          /* malformed receipt payload stays unindexed */
        }
        if (challengeId) this.receiptByChallenge.set(challengeId, receipt);
      }
      return;
    }
    throw new Error("gate ledger has an unknown record type");
  }

  private append(record: Record): void {
    writeSync(this.fd, JSON.stringify(record) + "\n");
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }

  /** Persist a freshly issued session. Duplicate session ids refuse. */
  issueSession(session: GateSession): void {
    if (this.sessions.has(session.sessionId)) throw new Error("session id already issued");
    this.append({ type: "session", session });
    this.sessions.set(session.sessionId, session);
  }

  /** Look up a session and whether a decision was already recorded for it. */
  session(sessionId: string): { session: GateSession; decided: boolean } | null {
    const session = this.sessions.get(sessionId);
    return session ? { session, decided: this.decided.has(sessionId) } : null;
  }

  /**
   * Atomically consume a session into its decision: receipts plus the signed
   * admission land in one appended record. Already-decided or unknown
   * sessions refuse before anything is written.
   */
  decide(sessionId: string, admission: Admission, receipts: Receipt[]): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("unknown session");
    if (this.decided.has(sessionId)) throw new Error("session already decided");
    this.append({ type: "decision", sessionId, admission, receipts });
    this.decided.add(sessionId);
    for (const receipt of receipts) {
      const challengeId = (JSON.parse(receipt.payload) as { challenge: { challengeId: string } }).challenge.challengeId;
      this.receiptByChallenge.set(challengeId, receipt);
    }
  }

  /** A minted receipt by challenge id, if the challenge produced one. */
  receipt(challengeId: string): Receipt | null {
    return this.receiptByChallenge.get(challengeId) ?? null;
  }
}
