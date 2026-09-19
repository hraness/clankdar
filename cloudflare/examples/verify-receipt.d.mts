import type { GatePolicy } from "../../bench/gate.ts";
export interface VerifiedReceipt {
  ok: true; sha256: string; issuerPublicKey: string; sessionId: string;
  context?: string; pass: boolean; passed: number; required: number;
  policy: GatePolicy; decidedAt: string; expiresAt: string;
}
export function verifyReceipt(input: string | Uint8Array | unknown, options: {
  issuerPublicKey: string; context?: string; sessionId?: string; sha256?: string;
}): VerifiedReceipt | { ok: false; reason: string };
