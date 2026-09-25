/** Copy the official pinned binary unchanged; never rebuild or alter its semantics. */
import { mkdirSync, writeFileSync } from "node:fs";
import { algalWasmBytes } from "../ladder/algal/artifact.ts";
import { ALGAL_WASM_SHA256 } from "../ladder/algal/provenance.ts";
const bytes = algalWasmBytes();
const directory = new URL("./generated/", import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL("algal-expr.wasm", directory), bytes);
console.log(`ALGAL evaluator verified: ${bytes.byteLength} bytes, sha256:${ALGAL_WASM_SHA256}`);
