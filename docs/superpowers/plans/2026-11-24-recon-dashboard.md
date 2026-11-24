# Recon dashboard Implementation Plan

> **For agentic workers:** execute task by task with TDD (failing test first, watch it fail), one conventional commit per
> task ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Goal:** `/` becomes the recon performance view of a period across the viewer's spaces (spec
`docs/superpowers/specs/2026-11-24-recon-dashboard-design.md`, binding); the old admin numbers move to a bottom section
for `user.view` / `audit.view` holders.

**Architecture:** a rollup table `recon_day_stats` (engine module, space-owned, RLS) per (space, config, business date),
recomputed whole from the engine's tables by a debounced pg-boss job (`recon.stats`, keyed `config:date`, 60 s) after a
run and after a resolution, plus a nightly sweep of the last 7 days. "Now" numbers (open unmatch, age, reason, waiting
approval) and the low-volume period numbers (posting runs, approval decisions: one row per request) are live queries.
One read `GET /v1/dashboard/recon` (dashboard module route, engine module service) answers every number; the web screen
renders it.

## Number definitions (what each counts, and the list it opens with which query)

Scope: spaces the viewer holds a role in (Superadmin: every space, DEC-051), or the one `space` picked (404 when not in
scope); `recon` narrows to one recon (404 when not in scope). Period `from..to` (Asia/Jakarta business dates, default the
last 7 days ending today), previous period = the same number of days just before. Links exist only when the number has
one space in scope (one space picked, or the viewer has one); with several spaces each row of the per-space summary
links instead. Operation result is per recon, so its links need one recon (the recons table rows always have one).

Rollup row `recon_day_stats(space_id, config_id, business_date)`, recomputed from source in one upsert:

| Column | Definition |
| --- | --- |
| `results` | Operation result rows of that business date per overall status: `{ status: [rows, records] }`, from the same SQL as `GET …/results/counts` (`resultRows` in `engine/results.ts`, dates `[d, d]`, no filter); records = side A + side B items of the row |
| `broke` | live items of the date whose `break_reason` is set (they became unmatch, whatever happened after) |
| `written_off` | per currency, the sum of absolute record amounts of live items of the date resolved `WRITTEN_OFF` |
| `resolve_minutes` | per Operation result row of the date with a Resolved status (the rows `Resolved` counts): minutes from its resolved items' business date start (Asia/Jakarta) to their `state_at` (`break_state = resolved`; a late-data match is resolved when its run claims it) |
| `computed_at` | when it was written |

| Number | Definition | Links to |
| --- | --- | --- |
| Auto-match rate | Σ records of `matched` rows ÷ Σ records of all rows over the period's rows; change vs previous period in points, `good` up | Operation result `?recon=&dateFrom=&dateTo=&result=matched` |
| Unmatch open | live: `breakSummary` of each space (the Unmatch list's own function, `recon` filter): count; value IDR headline, other currencies in the tooltip; "N past carry over" = its `pastCarryOver`. Change: `broke` of the period vs previous, `good` down | Unmatch `/spaces/:id/breaks?recon=` |
| Resolved · of this period's items | Σ rows of statuses `matched_late, matched_by_hand, force_matched, posted, written_off, adjusted, closed` over the period's business dates; median of `resolve_minutes` (the same rows), from the item's business date to its resolution; change vs previous, `good` up | Operation result `?…&result=<those statuses>` |
| Posting success | live: `action_runs` kind posting of the scope, day of `coalesce(finished_at, created_at)` in the period: posted ÷ (posted + failed + timeout + not_sent); failed count = failed + timeout + not_sent; change in points, `good` up | Posting `/spaces/:id/posting?kind=posting&status=failed,timeout,not_sent&recon=&dateFrom=&dateTo=` |
| Waiting approval | live: pending `approval_requests` of the space (break requests, every recon: the inbox has no recon filter), oldest `requested_at`; change = requests made in the period vs previous, `good` down | Approvals `/spaces/:id/approvals?mine=0&kind=<REQUEST_KINDS>` |
| Results per day | per date: auto = records of `matched` rows; by hand + force = records of `matched_by_hand` + `force_matched` rows; new unmatch = `broke`; line = auto-match rate | — |
| Unmatch by age | live: the Unmatch list's open items by age 0–1 d (`d0,d1`), 2–3 d (`d2_3`), 4–7 d (`d4_7`), > 7 d (`d8_30,gt30`, flagged); count and value per currency | Unmatch `?age=` |
| Unmatch by reason | live: open items per `break_reason` (same filter) | Unmatch `?reason=` |
| How items were closed | rows of `matched` (auto), `matched_late`, `matched_by_hand`, `force_matched`, `posted`, `written_off` (+ `written_off` value), `closed` + `adjusted` (closed) over the period | Operation result `?result=` |
| Per space | per space: open unmatch value (IDR + others), auto-match rate, written-off value | the row's Unmatch list |
| Recons table | per recon: volume (records), auto-match rate, open unmatch count and value (live), oldest open business date, posting failures (as Posting success), last live run status | Operation result of that recon for the period |
| Approvals | requests made in the period (`requested_at`), median `decided_at − requested_at` over requests decided in the period, rejected count | — (no list shows decided requests) |

## Tasks

1. **Shared contracts** — `packages/shared/src/contracts/dashboard.ts` `ReconDashboardQuery` / `ReconDashboardDto`;
   zod-free `packages/shared/src/dashboard.ts` (`RESOLVED_STATUSES`, `CLOSED_PARTS`, `AGE_GROUPS`, `median`); posting
   list query gains `recon`, `dateFrom`, `dateTo`. Test: `dashboard.test.ts` (median, groups cover AGE_BUCKETS once).
2. **Rollup** — `engine/schema.ts` `reconDayStats`; `drizzle/0065_recon_day_stats.sql` (+ `recon_enable_space_rls`);
   `engine/stats.ts` `recomputeDayStats(tx, spaceId, configId, date)`. Test `engine/tests/integration/day-stats.test.ts`:
   rollup = `GET …/results/counts` on a fixture, again after a resolution (close) and a reversal (group reversed);
   recompute twice = same row; another space's `withSpace` reads no row and can't write one.
3. **Job** — `QUEUES.reconStats` in `kernel/jobs.ts`; `queueStats(tx, spaceId, items)` after `matchIn`, `closeBreak`,
   `requestChange`, `applyBreakChange`, `revertBreakRequest`, and after a live run (`runAndRefresh`); handler + nightly
   sweep in `engine/jobs.ts`, cron in `worker.ts`. Test: a close queues one job keyed `config:date`, a second merges.
4. **Posting list filters** — `integrations/actions.ts` `runsWhere` honours `recon`, `dateFrom`, `dateTo`; web
   `ACTION_RUNS` passes them. Test in `integrations` tests.
5. **Dashboard read** — `spaces` `viewerSpaces(ctx)`; `engine/dashboard.ts` `reconDashboard(ctx, q)`; route
   `GET /v1/dashboard/recon` (guard null) in `dashboard/controller.ts`; `NON_LIST_GETS`; docs table + `api:schemas`.
   Test `dashboard/tests/integration/recon-dashboard.test.ts`: scope (member, non-member 404, Superadmin all), RLS
   isolation, currency kept apart, every linked number = its list (`breaks/summary`, `results/counts`, `action-runs`
   total, `approvals` total) for the same filters.
6. **Screen** — `features/dashboard/recon-dashboard.tsx` (filters, KPIs, charts via `@starterkit/ui/charts` in
   `LazyMount`, BreakdownCards, tables), admin section (old `DashboardPage` body) only when `adminSection(perms)`;
   query key `["dashboard", "recon", url]` in `queries.ts`; `reads.reconDashboard` prefetched in `app/(main)/page.tsx`;
   `loading.tsx` shape; header range default 7 days. Test: `dashboard-model.test.ts` (links, admin gate, headline
   currency).
7. **Verify** — `bun run check`, `cd apps/web && bun run build`, `bun run budget`.
