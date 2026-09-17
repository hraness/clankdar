/** A single generated puzzle instance. `answer` is the canonical truth. */
export interface Instance {
  family: string;
  tier: number;
  seed: number;
  prompt: string;
  answer: string;
}

/** A parameterized puzzle family. Tiers select difficulty parameters. */
export interface Family {
  readonly name: string;
  /** Tiers this family supports. */
  readonly tiers: readonly number[];
  generate(tier: number, seed: number): Instance;
}

/** Canonicalize an answer for exact comparison: lowercase, alnum only. */
export function normalize(answer: string): string {
  return answer.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function answersMatch(expected: string, got: string): boolean {
  return normalize(got) === normalize(expected);
}
