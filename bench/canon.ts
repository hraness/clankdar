/**
 * Shared canonical serialization and digest for signed/committed values.
 * One implementation so commitments can never diverge between modules.
 */
import { createHash } from "node:crypto";

/** Deterministic JSON for signing: keys sorted by code-unit order recursively. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
