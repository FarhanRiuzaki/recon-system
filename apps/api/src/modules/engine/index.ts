// Public API of the engine module: its routes (runs and simulations), the worker's job handlers, a run of a recon
// version (runRecon; createRun + execRun for a run started elsewhere, Task 6's ticks) and its tables (items, runs,
// match groups and members), which the result screens read.
export { engineController } from "./controller";
export { engineHandlers } from "./jobs";
export { createRun, execRun, RANGE_MAX_DAYS, type PassCounters, type RunCounters, type RunInput, type RunMode, type RunSummary, runRecon } from "./service";
export { matchGroups, matchMembers, reconItems, reconRuns } from "./schema";
