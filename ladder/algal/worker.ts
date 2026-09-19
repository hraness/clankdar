import module from "../../cloudflare/generated/algal-expr.wasm";
import { createEvaluator } from "./abi.ts";
const evaluator = createEvaluator(module);
export const { evalProgram, checkProgram } = evaluator;
