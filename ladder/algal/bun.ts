import { createEvaluator } from "./abi.ts";
import { algalWasmBytes } from "./artifact.ts";
const evaluator = createEvaluator(new WebAssembly.Module(algalWasmBytes()));
export const { evalProgram, checkProgram } = evaluator;
