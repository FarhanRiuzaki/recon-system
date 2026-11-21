// Which of a recon's runs its Overview shows (pure; the server prefetch and the browser hook pick the same).

type RunRow = { id: string; mode: string; startedAt: string };
/**
 * A recon's Overview (Captain, R6-1): its headline is the newest run that took in records (`withRecords`: GET
 * …/runs?records=1, newest first), else the newest real run of `latest` (newest first); a newer real run than the
 * headline is `newer` (one small line under it: no new records, running or stopped).
 */
export function pickLastRuns<R extends RunRow>(withRecords: readonly R[], latest: readonly R[]): { headline: R | null; newer: R | null } {
  const last = latest.find((r) => r.mode !== "simulation") ?? null;
  const headline = withRecords[0] ?? last;
  return { headline, newer: last && headline && last.id !== headline.id && last.startedAt > headline.startedAt ? last : null };
}
