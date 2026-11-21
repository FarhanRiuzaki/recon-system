// Which of a recon's runs its Overview shows (pure; the server prefetch and the browser hook pick the same).

type RunRow = { id: string; mode: string; counters: { intake: { a: number; b: number } } };
/**
 * A recon's Overview (Captain, R6-1): its headline is the newest real run that took in records, else the newest real
 * run; a newer real run without records is `newer` (one small line under the headline). Rows newest first.
 * ponytail: among the last 50 runs; GET …/runs?records=1 (coming) finds an older one when empty runs crowd it out.
 */
export function pickLastRuns<R extends RunRow>(rows: readonly R[]): { headline: R | null; newer: R | null } {
  const real = rows.filter((r) => r.mode !== "simulation");
  const headline = real.find((r) => r.counters.intake.a + r.counters.intake.b > 0) ?? real[0] ?? null;
  return { headline, newer: real[0] && real[0] !== headline ? real[0] : null };
}
