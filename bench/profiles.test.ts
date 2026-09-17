import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { readRuns, buildReport } from "./report.ts";
import { CAPABILITY_PROFILES, profileReport } from "./profiles.ts";

const report = buildReport(readRuns(resolve(import.meta.dir, "../site/benchmark/v2-calibration-0")));

describe("capability profiles", () => {
  test("partition every published v2 cell exactly once", () => {
    const cells = CAPABILITY_PROFILES.flatMap((profile) => profile.cells);
    expect(new Set(cells).size).toBe(report.cells.length);
    expect([...cells].sort() as string[]).toEqual(report.cells);
  });

  test("preserve each model's totals while exposing distinct profiles", () => {
    for (const result of profileReport(report)) {
      const cells = Object.values(result.profiles);
      expect(cells.reduce((sum, cell) => sum + cell.total, 0)).toBe(500);
      expect(cells.reduce((sum, cell) => sum + cell.passed, 0)).toBe(report.models.find((model) => model.model === result.model)!.all.passed);
      expect(cells.every((cell) => cell.interval95 !== null)).toBe(true);
    }
    const gpt5 = profileReport(report).find((result) => result.model === "openai/gpt-5-mini")!;
    expect(new Set(Object.values(gpt5.profiles).map((cell) => cell.strict)).size).toBeGreaterThan(1);
  });

  test("rejects reports whose coverage does not match the profile contract", () => {
    const changed = structuredClone(report);
    changed.cells.pop();
    expect(() => profileReport(changed)).toThrow("partition");
  });
});
