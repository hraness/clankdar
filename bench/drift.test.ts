import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateVerifier } from "./attest.ts";
import { checkAdmission, type GatePolicy } from "./gate.ts";
import { compareDrift, driftReport, makeBaseline, runDrift, type DriftRecord } from "./drift.ts";

const verifier = generateVerifier();
const policy: GatePolicy = { suite: "v2", cells: ["arithmetic:t0", "arithmetic:t1"], challenges: 2, minPass: 1, ttlSeconds: 300 };

const record = (over: Partial<DriftRecord> = {}): DriftRecord => ({
  type: "probe", ts: "2026-09-18T00:00:00Z", adapter: "stub", sessionId: "gs_aaaaaaaaaaaa",
  cells: ["arithmetic:t0", "arithmetic:t1"], passedCells: ["arithmetic:t0"],
  passed: 1, challenges: 2, verdict: true, admission: {} as DriftRecord["admission"], ...over,
});

describe("drift run", () => {
  test("each round appends a signed admission record to the series", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-drift-"));
    const series = join(dir, "drift.jsonl");
    const stub = { name: "stub", solve: async () => "0" };
    const records = await runDrift({ policy, verifierJwk: verifier.privateJwk, adapter: stub, rounds: 3, seriesPath: series });
    expect(records).toHaveLength(3);
    const lines = readFileSync(series, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as DriftRecord;
      expect(parsed.type).toBe("probe");
      expect(parsed.sessionId).toMatch(/^gs_/);
      expect(parsed.cells).toHaveLength(2);
      expect(checkAdmission(parsed.admission).ok).toBe(true);
    }
  });
});

describe("drift report", () => {
  test("aggregates per-cell and overall bands", () => {
    const report = driftReport([
      record(),
      record({ passedCells: ["arithmetic:t0", "arithmetic:t1"], passed: 2 }),
      record({ passedCells: [], passed: 0, verdict: false }),
    ]);
    expect(report.records).toBe(3);
    expect(report.challenges).toBe(6);
    expect(report.passed).toBe(3);
    expect(report.rate).toBeCloseTo(0.5);
    expect(report.admitted).toBe(2);
    expect(report.cells["arithmetic:t0"]).toEqual({ n: 3, passed: 2, rate: 2 / 3 });
    expect(report.cells["arithmetic:t1"]).toEqual({ n: 3, passed: 1, rate: 1 / 3 });
  });
});

describe("baseline compare", () => {
  const baseline = makeBaseline(
    [record({ passedCells: ["arithmetic:t0", "arithmetic:t1"], passed: 2 }), record({ passedCells: ["arithmetic:t0", "arithmetic:t1"], passed: 2 })],
    "stub",
  );

  test("a held band is ok", () => {
    const current = driftReport([record({ passedCells: ["arithmetic:t0", "arithmetic:t1"], passed: 2 })]);
    const result = compareDrift(current, baseline);
    expect(result.ok).toBe(true);
    expect(result.alerts).toHaveLength(0);
  });

  test("a dropped cell alerts and exits the ok flag", () => {
    const current = driftReport([
      record({ passedCells: ["arithmetic:t0"], passed: 1 }),
      record({ passedCells: ["arithmetic:t0"], passed: 1 }),
      record({ passedCells: ["arithmetic:t0"], passed: 1 }),
      record({ passedCells: ["arithmetic:t0"], passed: 1 }),
    ]);
    const result = compareDrift(current, baseline, 0.2);
    expect(result.ok).toBe(false);
    expect(result.alerts.some((a) => a.startsWith("arithmetic:t1"))).toBe(true);
    expect(result.alerts.some((a) => a.startsWith("overall"))).toBe(true);
  });

  test("a cell absent from the current series alerts", () => {
    const current = driftReport([record({ cells: ["arithmetic:t0"], passedCells: ["arithmetic:t0"], passed: 1, challenges: 1 })]);
    const result = compareDrift(current, baseline, 0.2);
    expect(result.ok).toBe(false);
    expect(result.alerts.some((a) => a.includes("absent"))).toBe(true);
  });

  test("new cells in the current series never alert", () => {
    const current = driftReport([
      record({ cells: ["arithmetic:t0", "arithmetic:t1", "echo:t0"], passedCells: ["arithmetic:t0", "arithmetic:t1", "echo:t0"], passed: 3, challenges: 3 }),
    ]);
    expect(compareDrift(current, baseline, 0.2).ok).toBe(true);
  });

  test("baseline requires a nonempty series", () => {
    expect(() => makeBaseline([], "stub")).toThrow("empty");
  });
});
