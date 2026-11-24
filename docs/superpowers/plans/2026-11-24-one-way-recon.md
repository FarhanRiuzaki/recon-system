# One-way recon Implementation Plan

> **For agentic workers:** TDD (failing test first, watch it fail), conventional commits ending
> `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Goal:** a recon version is two-way or one-way (A to B); in one-way, a side-B item without a counterpart is not
required, never an unmatch (spec `docs/superpowers/specs/2026-11-24-one-way-recon-design.md`, DEC-055).

## Tasks

1. Contract (failing first: `recon/tests/unit/rules.test.ts` "direction", `packages/shared/src/results.test.ts`):
   `RECON_DIRECTIONS`, `isOneWay`, `ReconSpec.direction` optional; `ITEM_STATUSES` + `not_required`;
   `RESULT_STATUSES` / `SIDE_STATES` + `not_required`. `bun run api:schemas`.
2. Engine (failing first: `engine/tests/integration/one-way.test.ts`): `StepCtx.oneWay` / `ClassifyCtx.oneWay`;
   `nearMissSql` answers `Not required` for side B; `breakLocked` writes `not_required`; `closeDaySql` counts it apart
   (`nr`), `closeDay` / `sweepClosed` queue the rollup for it; pool, suggestions and tie breaks take it; replaced
   records close it; migration 0069 (status check, partial index, columns unqualified for the partitions).
3. Readers: Operation result SQL status and side state; `free` and the candidate list; dashboard records.
4. Web (failing first: `spec-model.test.ts` "direction", `result-model.test.ts`, `run-model.test.ts` projection):
   the Sources step's Direction radio cards, the spec view and overview line, result status icon/tone/legend, the
   projection's "not required", Explain's item label.
5. Docs: this plan, the design, DEC-055. `bun run check`, `cd apps/web && bun run build`, `bun run budget`.
