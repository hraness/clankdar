import { b64url, canonical, sha256Bytes, unb64url } from "./protocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function wrappingKey(secret: string, environment: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  if (secret === "test") {
    if (environment !== "test") throw new Error("test wrapping key is forbidden outside tests");
    raw = await sha256Bytes("clankdar/test/session-wrap-key");
  } else {
    try { raw = Uint8Array.from(atob(secret.trim()), (char) => char.charCodeAt(0)); } catch { throw new Error("SESSION_WRAP_KEY must be base64"); }
    if (raw.length !== 32) throw new Error("SESSION_WRAP_KEY must decode to 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealJson(value: unknown, aad: string, secret: string, environment: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, await wrappingKey(secret, environment), encoder.encode(canonical(value)));
  return `${b64url(iv)}.${b64url(ciphertext)}`;
}

export async function openJson<T>(sealed: string, aad: string, secret: string, environment: string): Promise<T> {
  const [ivText, cipherText, extra] = sealed.split(".");
  if (!ivText || !cipherText || extra !== undefined) throw new Error("sealed value is malformed");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(ivText), additionalData: encoder.encode(aad) }, await wrappingKey(secret, environment), unb64url(cipherText));
  return JSON.parse(decoder.decode(plaintext)) as T;
}
