// Public API of the engine module: its routes (runs and simulations), the worker's job handlers, a run of a recon
// version (runRecon; createRun + execRun for a run started elsewhere, Task 6's ticks) and its tables (items, runs,
// match groups and members), which the result screens read; the near-miss classifier (classifyUnmatched: why an open
// item has no pair, the one rule of day close and simulation).
export { engineController } from "./controller";
export { engineHandlers } from "./jobs";
export { NEAR_MISS, type NearMissReason } from "./sql/breaks";
export { classifyUnmatched, createRun, execRun, type NearMiss, RANGE_MAX_DAYS, type PassCounters, type RunCounters, type RunInput, type RunMode, type RunSummary, runRecon } from "./service";
export { matchGroups, matchMembers, reconItems, reconRuns } from "./schema";
