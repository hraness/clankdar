import { expect, test } from "bun:test";
import { publicPilotRow, verifyPilot } from "./pilot.ts";
import { resolve } from "node:path";

test("pilot export omits raw errors and unknown private fields", () => {
  const input = { adapter: "model", family: "echo", tier: 0, seed: 1, prompt: "", expected: "", response: "", pass: false, latencyMs: 12, error: "private provider detail", apiKey: "do not publish" };
  const row = publicPilotRow(input);
  expect(row.error).toBe("provider_error");
  expect(JSON.stringify(row)).not.toContain("private provider detail");
  expect(JSON.stringify(row)).not.toContain("do not publish");
});

test("published pilot is reproducible from the archived responses", () => {
  const report = verifyPilot(resolve(import.meta.dir, "../site/benchmark/pilot-v0"));
  expect(report.models).toHaveLength(12);
  expect(report.models.reduce((sum, model) => sum + model.all.total, 0)).toBe(3000);
  expect(report.models.reduce((sum, model) => sum + model.all.errors, 0)).toBe(1);
  expect(report.models.every((model) => model.eligible.total === 190)).toBe(true);
  expect(report.excludedFamilies).toEqual(["gridpath", "gridxf", "hiddenfn", "sequence"]);
});
