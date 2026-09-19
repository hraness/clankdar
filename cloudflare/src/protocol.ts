export const ACTOR_REQUEST_DOMAIN = "clankdar/actor-request/v1";
export const ACTOR_REGISTER_DOMAIN = "clankdar/actor-register/v1";
export const ACTOR_EVENT_DOMAIN = "clankdar/actor-event/v1";
export const ACTOR_ADDRESS = /^clank1_[A-Za-z0-9_-]{27}$/;
export const REQUEST_NONCE = /^[A-Za-z0-9_-]{16,64}$/;
export const SIGNATURE = /^[A-Za-z0-9_-]{80,100}$/;

const encoder = new TextEncoder();

export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical JSON accepts safe integers only");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON rejects this value");
}

export const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const unb64url = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const sha256Bytes = async (value: string | Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value));
export const sha256 = async (value: string | Uint8Array): Promise<string> =>
  [...await sha256Bytes(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export async function actorAddress(publicKey: string): Promise<string> {
  const raw = unb64url(publicKey);
  if (raw.length !== 32) throw new Error("actor public key must be 32-byte Ed25519 x");
  return `clank1_${b64url((await sha256Bytes(raw)).slice(0, 20))}`;
}

export async function importActorKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicKey, ext: true }, { name: "Ed25519" }, false, ["verify"]);
}

export async function verifyActorSignature(publicKey: string, transcript: unknown, signature: string): Promise<boolean> {
  try {
    if (!SIGNATURE.test(signature)) return false;
    return await crypto.subtle.verify("Ed25519", await importActorKey(publicKey), unb64url(signature), encoder.encode(canonical(transcript)));
  } catch {
    return false;
  }
}

export const registrationTranscript = (publicKey: string, timestamp: string, nonce: string): unknown[] =>
  [ACTOR_REGISTER_DOMAIN, publicKey, timestamp, nonce];

export async function requestTranscript(address: string, publicKey: string, timestamp: string, nonce: string, method: string, pathname: string, body: Uint8Array): Promise<unknown[]> {
  return [ACTOR_REQUEST_DOMAIN, address, publicKey, timestamp, nonce, method.toUpperCase(), pathname, await sha256(body)];
}

export interface ActorAuthHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

export function actorAuthHeaders(headers: Headers): ActorAuthHeaders | null {
  const timestamp = headers.get("x-clankdar-timestamp") ?? "";
  const nonce = headers.get("x-clankdar-nonce") ?? "";
  const signature = headers.get("x-clankdar-signature") ?? "";
  if (!Number.isFinite(Date.parse(timestamp)) || !REQUEST_NONCE.test(nonce) || !SIGNATURE.test(signature)) return null;
  return { timestamp, nonce, signature };
}

export function timestampCurrent(timestamp: string, now = Date.now(), windowMs = 300_000): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && Math.abs(now - parsed) <= windowMs;
}

export async function actorEventHash(previous: string, body: unknown): Promise<string> {
  return sha256(canonical([ACTOR_EVENT_DOMAIN, previous, body]));
}
