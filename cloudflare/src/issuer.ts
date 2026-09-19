import { b64url, canonical, sha256, unb64url } from "./protocol.ts";

export interface IssuerIdentity {
  publicKey: string;
  keyId: string;
  sign(payload: string): Promise<string>;
}

const encoder = new TextEncoder();
let testIdentity: Promise<IssuerIdentity> | undefined;

async function fromPair(pair: CryptoKeyPair): Promise<IssuerIdentity> {
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  if (typeof publicJwk.x !== "string") throw new Error("issuer key has no Ed25519 x member");
  const publicKey = publicJwk.x;
  const keyId = (await sha256(unb64url(publicKey))).slice(0, 16);
  return {
    publicKey,
    keyId,
    sign: async (payload) => b64url(await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(payload))),
  };
}

export async function issuerIdentity(secret: string, environment: string): Promise<IssuerIdentity> {
  if (secret === "test") {
    if (environment !== "test") throw new Error("test issuer key is forbidden outside tests");
    testIdentity ??= crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]).then((pair) => fromPair(pair as CryptoKeyPair));
    return testIdentity;
  }
  let jwk: JsonWebKey;
  try { jwk = JSON.parse(secret) as JsonWebKey; } catch { throw new Error("ISSUER_JWK is not JSON"); }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string") throw new Error("ISSUER_JWK must be an Ed25519 private JWK");
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const publicKey = jwk.x;
  const keyId = (await sha256(unb64url(publicKey))).slice(0, 16);
  return {
    publicKey,
    keyId,
    sign: async (payload) => b64url(await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(payload))),
  };
}

export async function signCanonical(identity: IssuerIdentity, body: unknown): Promise<{ payload: string; signature: string }> {
  const payload = canonical(body);
  return { payload, signature: await identity.sign(payload) };
}
