/** Bun/build-time artifact reader; never included in the Worker bundle. */
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ALGAL_WASM_SHA256 } from "./provenance.ts";
export function algalWasmBytes(): Uint8Array<ArrayBuffer> {
  const bytes = readFileSync(new URL("./src/algal_expr.wasm", import.meta.resolve("@hraness/algal")));
  if (createHash("sha256").update(bytes).digest("hex") !== ALGAL_WASM_SHA256) throw new Error("Algal evaluator artifact does not match the frozen suite pin");
  return new Uint8Array(bytes);
}
