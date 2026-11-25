/**
 * A test's time budget in ms. TEST_PERF_FACTOR (default 1) widens every budget for a test database on another host,
 * where each round trip adds the network (tibsdev: tibsdbdev). CI keeps the budgets as written.
 */
export function budget(ms: number): number {
  const f = Number(process.env.TEST_PERF_FACTOR ?? 1);
  return ms * (Number.isFinite(f) && f >= 1 ? f : 1);
}
