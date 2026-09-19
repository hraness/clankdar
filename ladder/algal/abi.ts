/** Host ABI only. Every expression operation executes in the pinned official Algal WASM. */
import { ALGAL_FUEL_LIMIT } from "./provenance.ts";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ExprResult = { ok: true; value: JsonValue; fuel: number } | { ok: false; err: { code: string; [key: string]: JsonValue }; fuel: number };
export type ExprCheck = { ok: true } | { ok: false; err: { code: string; [key: string]: JsonValue } };
interface Exports {
  memory: WebAssembly.Memory;
  algal_alloc(length: number): number;
  algal_dealloc(pointer: number, length: number): void;
  algal_eval(pointer: number, length: number): bigint;
  algal_check(pointer: number, length: number): bigint;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 65_536;
// The official binary owns its memory. Discard an instance beyond this
// retained-memory ceiling; generated programs and inputs also have tight bounds.
const MAX_RETAINED_MEMORY = 16 * 1024 * 1024;

export function createEvaluator(module: WebAssembly.Module) {
  if (WebAssembly.Module.imports(module).length) throw new Error("Algal evaluator must have no host imports");
  let instance: Exports | undefined;
  const call = (operation: "algal_eval" | "algal_check", request: JsonObject): unknown => {
    const bytes = encoder.encode(JSON.stringify(request));
    if (bytes.byteLength > MAX_REQUEST_BYTES) throw new Error("Algal request exceeds its byte limit");
    const ex = instance ??= new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    if (ex.memory.buffer.byteLength > MAX_RETAINED_MEMORY) { instance = undefined; throw new Error("Algal retained memory limit exceeded"); }
    let input = 0, output = 0, outputLength = 0;
    try {
      input = ex.algal_alloc(bytes.byteLength);
      if (!input) throw new Error("Algal input allocation failed");
      new Uint8Array(ex.memory.buffer, input, bytes.byteLength).set(bytes);
      const packed = ex[operation](input, bytes.byteLength);
      if (!packed) throw new Error("Algal evaluator returned no result");
      output = Number(packed >> 32n);
      outputLength = Number(packed & 0xffff_ffffn);
      if (outputLength > MAX_RESPONSE_BYTES || ex.memory.buffer.byteLength > MAX_RETAINED_MEMORY) throw new Error("Algal result exceeds its memory or byte limit");
      return JSON.parse(decoder.decode(new Uint8Array(ex.memory.buffer, output, outputLength)));
    } catch (error) {
      instance = undefined;
      throw error;
    } finally {
      if (input) ex.algal_dealloc(input, bytes.byteLength);
      if (output) ex.algal_dealloc(output, outputLength);
    }
  };
  return {
    evalProgram(program: JsonValue, env: JsonObject, fuel = ALGAL_FUEL_LIMIT): ExprResult {
      if (!Number.isSafeInteger(fuel) || fuel < 0 || fuel > ALGAL_FUEL_LIMIT) throw new Error("Algal fuel must be an integer from 0 to 10000");
      return call("algal_eval", { program, env, fuel }) as ExprResult;
    },
    checkProgram(program: JsonValue, names: readonly string[]): ExprCheck {
      return call("algal_check", { program, names: [...names] }) as ExprCheck;
    },
  };
}
