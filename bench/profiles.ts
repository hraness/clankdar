import type { CalibrationReport } from "./report.ts";
import { wilson } from "./stats.ts";

export const CAPABILITY_PROFILES = [
  {
    id: "transform-fidelity",
    name: "Transform fidelity",
    description: "Follow exact text and symbol transformation contracts.",
    cells: ["echo:t0", "strings:t1", "strings:t2", "cipher:t2"],
  },
  {
    id: "symbolic-execution",
    name: "Symbolic execution",
    description: "Carry deterministic arithmetic, machine-state, and automaton steps.",
    cells: ["arithmetic:t0", "arithmetic:t1", "arithmetic:t2", "registervm:t3", "registervm:t4", "automata:t4", "automata:t5"],
  },
  {
    id: "constraint-solving",
    name: "Constraint solving",
    description: "Satisfy ordering, path, logic, Sudoku, and alphametic constraints.",
    cells: ["ordering:t3", "gridpath:t3", "knights:t3", "knights:t4", "sudoku:t3", "sudoku:t4", "sudoku:t5", "cryptarithm:t4", "cryptarithm:t5"],
  },
  {
    id: "rule-induction",
    name: "Rule induction",
    description: "Infer a declared finite rule from examples and apply it to a new input.",
    cells: ["sequence:t2", "hiddenfn:t5", "hiddenfn:t6", "gridxf:t5", "gridxf:t6"],
  },
] as const;

export function profileReport(report: CalibrationReport) {
  const assigned = CAPABILITY_PROFILES.flatMap((profile) => profile.cells).sort();
  if (new Set(assigned).size !== assigned.length || JSON.stringify(assigned) !== JSON.stringify([...report.cells].sort())) throw new Error("capability profiles must partition report cells exactly once");
  return report.models.map((model) => ({
    model: model.model,
    profiles: Object.fromEntries(CAPABILITY_PROFILES.map((profile) => {
      const cells = profile.cells.map((cell) => model.byCell[cell]);
      if (cells.some((cell) => !cell)) throw new Error(`missing profile cell for ${model.model}`);
      const total = cells.reduce((sum, cell) => sum + cell.total, 0);
      const n = cells.reduce((sum, cell) => sum + cell.n, 0);
      const errors = cells.reduce((sum, cell) => sum + cell.errors, 0);
      const passed = cells.reduce((sum, cell) => sum + cell.passed, 0);
      const finalAnswerMatches = cells.reduce((sum, cell) => sum + cell.finalAnswerMatches, 0);
      return [profile.id, { total, n, errors, passed, strict: n ? passed / n : null, interval95: wilson(passed, n), finalAnswerMatches, finalAnswer: n ? finalAnswerMatches / n : null }];
    })),
  }));
}
