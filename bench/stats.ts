export function wilson(passed: number, n: number): [number, number] | null {
  if (!Number.isInteger(n) || !Number.isInteger(passed) || n < 0 || passed < 0 || passed > n) throw new Error("invalid success counts");
  if (!n) return null;
  const z = 1.959963984540054;
  const p = passed / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
