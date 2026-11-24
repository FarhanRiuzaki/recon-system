# Recon dashboard — design

Status: owner asked 2026-11-24 ("design dashboard di ganti dengan module2 nya recon … lo sebagai data analyst dan juga
user dan PO"); audience includes management ("iya juga buat manajemen, ambil rekomendasi lo").

## Intent

`/` (Dashboard) shows the starterkit's admin numbers (users, sessions, sign-ins). It becomes the recon performance view
for a period: how well reconciliation runs, where the problems sit, and what they are worth. Today stays the per-space
"what needs me now" screen; Dashboard answers "how did we do this period, and where is it going wrong".

Readers: operations team (priorities), management (value and trend), product owner (does automation work).

## Goals

- Filters in the header: Space (all my spaces, or one), Recon (all, or one), Period (`DateRangeControl`, default last 7
  days, Asia/Jakarta business dates), compared with the period before.
- KPI row (`StatTile`, each with change vs the period before, `good` set by meaning):
  - Auto-match rate: auto-matched records ÷ all records of the period's business dates.
  - Unmatch open: count and value (IDR; other currencies listed in the tooltip), with "N past carry over".
  - Resolved: unmatch items resolved in the period, median time from break to resolution.
  - Posting success: posted ÷ posting runs finished in the period, with failed count.
  - Waiting approval: pending requests, oldest age.
- Results per day: stacked columns (auto match, by hand + force, new unmatch) with the auto-match rate as a line.
- Unmatch by age (`BreakdownCard`): 0–1 d, 2–3 d, 4–7 d, > 7 d, count and value; > 7 d flagged.
- Unmatch by reason (`BreakdownCard`).
- How items were closed in the period: auto, late data, by hand, force, posted, written off (with value), closed.
- Per space summary (management): open unmatch value, auto-match rate, written-off value, per space.
- Recons table: recon, space, volume, auto-match rate, unmatch open (count, value), oldest, posting failures, last run
  status; a row opens that recon's Operation result for the period.
- Approvals: requests in the period, median time to final decision, rejected count.
- Sources: deliveries on time vs late in the period (definition below).
- Every number links to the screen that lists it with the same filters (Unmatch, Operation result, Posting, Approvals).
- The old admin numbers (active users, sessions, sign-ins, recent activity) move to a section at the bottom shown only
  to holders of `user.view` / `audit.view`.

## Sources on time vs late (definition)

Ruling (core, 2026-11-24). For each source in scope (the spaces' own sources and those their recons read; with a recon
picked, the sources it reads) and each business date D of the period in the source's calendar:

- **Complete**: D's data is all in. A file inbox source: a file named for D ingested. A snapshot source: D's snapshot
  active. A pulled source: `complete_through` past the end of D (Asia/Jakarta).
- **Completed at**: the moment D first became complete, kept by ingest in `source_deliveries` (one row per source and
  date, written in the transaction that ingests the file, activates the snapshot or moves `complete_through`; the first
  completion wins, a later file version or snapshot never moves it). A pulled source's first pull is its baseline: the
  dates it completes at once get no row.
- **Due**: the source's own rule: a pulled source's grace after the end of D; a file or snapshot source's deadline on the
  day after D (its file of D arrives the next morning, as health judges it). Without one, the earliest close of D plus
  grace among the published recons reading it (when the recon closes D anyway, marked incomplete). Without either, the
  end of the day after D.
- **On time**: completed at ≤ due. **Late**: completed at > due. **Missing**: not complete and now ≥ due. **Unknown**:
  complete but no completed-at kept (completed before the table existed, a pull's baseline, or a watermark that is no
  time). Not complete and not yet due: not counted. A date due before the source was made: not counted.
- **On-time rate** = on time ÷ (on time + late + missing); unknown stays out of it and is shown on its own.

## Non-goals

- Editable or custom dashboards, exports, scheduled email reports (later, if asked).
- Replacing Today.

## Anti-goals

- A number on the dashboard that disagrees with the list it links to for the same filters.
- Mixing currencies into one sum: values are per currency; the headline shows IDR, others in the tooltip.
- Data of a space the viewer has no role in (Superadmin sees every space, DEC-051).

## Approach (my call, owner delegated)

1. **Daily rollups + live "now" numbers** — picked. A `recon_day_stats` row per (space, config, business date)
   holds the period numbers (records per side, auto/late/manual/force matched, new unmatch, resolved by resolution
   with values, posting runs by outcome, approvals decided and their durations). The engine recomputes a day's row
   after each run of it and after any resolution touching it (a debounced pg-boss job keyed per config+date), plus a
   nightly sweep of the last 7 days. "Now" numbers (open unmatch, aging, waiting approvals) are live queries like Today.
2. All live queries. Always exact, but 7–30 days × many recons × up to 200k results a day per recon is too heavy per
   page load (the Operation result volume test needs ~3 s for one recon over 31 days).
3. Materialized views refreshed on a timer. Fewer code paths, but refresh is all-or-nothing and RLS doesn't apply to
   materialized views in PostgreSQL, which breaks the space rule.

## Constraints

- `recon_day_stats` is space-owned: RLS through `recon_enable_space_rls`, read through `withSpace` per space the viewer
  holds a role in; the cross-space view sums per space on the API.
- Rollup writes are idempotent (recompute the whole row from source tables), so a missed or repeated job converges.
- First-load JS ≤ 300 kB on `/`: charts through `LazyMount`/`next/dynamic`.
- Status and chart colour rules (`chart-1…6` for series, status tones for statuses); legends in `Panel`.

## Left to the builder

- Exact SQL of the rollup; the debounce window (my suggestion: 1 minute).
- Chart component choice within `@starterkit/ui/charts`.
