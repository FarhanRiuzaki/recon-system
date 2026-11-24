# Operation result — design

Status: draft for owner approval, 2026-11-24.

## Intent

The operations team of each space checks, per recon, how its results stand overall: what matched, what is unmatch, what
was posted, written off or closed, for a business-date range (default today). Today that picture is spread over the run
page (one run at a time), Unmatch (open items across recons) and Posting (action runs across recons). Operation result
puts one recon's whole outcome in one table, with columns that recon's people chose.

It is a **preview**. Nothing is decided on this screen; a row that needs work links to where the work is done.

## Goals

- A space menu **Operation result**: pick a recon, a business-date range (default today, at most 31 days), see every
  result of that recon in those dates.
- **One row per result**: a match group (any size, both sides), or an item no group holds (unmatch open or closed).
- Fixed columns: **Status** (overall, an icon), **A** and **B** (per side, an icon), **Action** (Explain; Open on items
  with an Unmatch page).
- Configurable columns per recon: which show, their order and their heading, from side A source fields, side B source
  fields, or recon info.
- A **legend** of the status icons, and **counts per status** above the table that filter it when clicked.
- **Server paging, default 15 rows** (owner: "harus paging, agar ga berat"), sizes 15 | 25 | 50 | 100 like every list;
  the API never answers an unbounded list.
- Filters: overall status, per-side status, reference search, date range.
- Column setup edited on the recon's page **without a version and without approval**; each change recorded in the
  recon's History.

## Non-goals

- No actions on this screen (match, posting, write-off stay on the Unmatch item page).
- No export in this round (owner: preview only). The API takes the same filters, so a CSV can follow.
- No cross-recon table: columns differ per recon, so the screen holds one recon at a time.
- No sorting by a source field (see Constraints).

## Anti-goals

- A status here that disagrees with Unmatch, Posting or the run page. One source of truth: the same tables they read.
- Column setup that silently drops a column because a source field was renamed: a missing field shows as a column whose
  cells say "Field not in the source" and the setup marks it, never a quiet removal.
- Machine names on screen (field keys, enum values): headings are labels, statuses words + icons (recon-ui-no-slop).

## The screen

```
Operation result                                                    
Recon [BI-FAST vs Core ▾]  Business date [24 Nov 2026 – 24 Nov 2026]  [Search reference]   [Columns ▾]

Matched 1,204 · Unmatch 37 · Waiting approval 5 · Posted 12 · Posting failed 2 · …   (each a filter)

| Status | A | B  | Ref    | Amount    | Merchant | Business date | Action         |
|  ✓     | ✓ | ✓  | TRX-01 | 1,000,000 | M-0012   | 24 Nov 2026   | Explain        |
|  ⚡    | ✓ | ✓3 | TRX-05 | 3,000,000 | 3 values | 24 Nov 2026   | Explain        |
|  ↑     | ✗ | –  | TRX-02 |   250,000 | M-0040   | 24 Nov 2026   | Explain · Open |
                                                       Rows per page [15 ▾]   ‹ 1 2 3 … 84 ›
```

The legend is the table card's "Status legend" button (`Panel legend={…}`), the one place the repo allows a status
legend (AGENTS.md §7, `architecture.test.ts` "StatusLegend is rendered only by Panel"); it lists every icon below.

Icons come from the app's icon set; the glyphs above are placeholders. Colours follow the status tone map
(`apps/web/src/lib/shared/categories.ts`): green done, red failed/unmatch, amber needs a look, blue under way, grey
nothing/off.

### Overall status (one per row, first that holds)

Every row gets exactly one; the builder pins the order with a test over every combination the tables allow, and the
status filter and counts use the same function.

| Status | Holds when | Tone |
|---|---|---|
| Posting failed | the row's latest posting run is failed, timeout or not sent | red |
| Posting in progress | its latest posting run is queued, sending, or waiting in an open group | blue |
| Posting skipped | resolution POSTED and its latest posting run is no posting rule or skipped | amber |
| Waiting approval | an item of the row has a pending request | blue |
| Posted | resolution POSTED (its posting run posted, or none was ever made) | green |
| Written off | resolution WRITTEN_OFF | grey |
| Adjusted | resolution ADJUSTED | grey |
| Closed | resolution DUPLICATE or NO_ACTION, or item status closed | grey |
| Force matched | group kind force (or resolution FORCE_MATCHED) | green |
| Matched by hand | group kind manual (or resolution MATCHED_MANUAL) | green |
| Matched late | resolution AUTO_MATCHED_LATE_DATA | green |
| Suggested | group kind suggested, or a break with a proposed counterpart | amber |
| Matched | group kind auto | green |
| Unmatch | item status break, no resolution | red |
| Waiting for counterpart | item status open (still within its grace; a run has not broken it yet) | blue |

The posting statuses use the Posting page's own words for the run (`POSTING_STATUS_LABEL`) in the row's Posting status
column, so the two screens never disagree. "Latest posting run" of an item: its own `action_runs` row (kind posting) or,
for a grouped posting, the group's run through `posting_group_items` → `posting_groups.run_id` (an open group = in
progress).

### Per side (A, B)

✓ green: the side's records are in the group. ✗ red: an unmatch item of that side. – grey: no record of that side in
the row. ? amber: suggested. A count beside the icon when the side holds more than one record (`✓3`).

### Cells of a group with several records on a side

- Amount: the sum of that side's records (signed, its currency; mixed currencies say "Mixed").
- Any other source field, and every recon-info column (assignee, unmatch reason, resolution note, resolved at, bank
  reference, posting status): the value when every item of the side has the same one, else "N values". Explain shows
  each record. These columns don't sort.

## Column setup

- Lives on the recon's page (Configuration tab, a panel "Operation result columns" with Edit), outside the versioned
  spec: changing it needs no new version and no approval (owner).
- Who edits: config maker or space admin (who edits recons today, `apps/api/src/modules/recon/controller.ts`). Every
  role of the space reads.
- A column is one of:
  - a source field of side A or side B, picked from the fields of the source each side of the recon's **published**
    version reads (that source's published version). A recon with no published version has no results and is not
    offered in the recon picker.
  - recon info: business date, pass, unmatch reason, assignee, posting status, bank reference, resolution note,
    resolved at.
- Per column: heading (defaults to the field's label), order. At most 20 columns.
- Status, A, B and Action are always there and not part of the setup.
- No setup yet → default columns: Ref A, Amount A, Ref B, Amount B, Business date.
- Each save writes an activity entry (`recordActivity`, action `recon.result_columns`) with before/after, shown in the
  recon's History.
- Each viewer still hides columns for themselves with the table's Columns menu (existing per-table preference).

## Approach (picked: 1)

1. **Live query over the existing tables** — picked. The API builds rows on each request from `match_groups` +
   `match_members` and the `recon_items` no group holds, joined to `records` (`attrs` for source fields), the latest
   `approval_requests` and `action_runs` per item. The column setup is a small new table, not versioned.
   Always current, same truth as Unmatch and Posting, no new engine path. Ceiling: no sort by a source field (jsonb),
   range capped at 31 days, paged.
2. A result table the engine writes at run end and on every change (manual match, posting, write-off, close). Fastest
   reads and any sort, but every one of the dozen-plus paths that change a result must write it, one missed path shows a
   wrong status, and a column change rewrites history. About twice the work.
3. Extend the run page's item table with configurable columns. Cheapest, but one run at a time and no status after
   actions: misses the point.

**Volume (owner unsure; my call):** start with 1 and pin it with a performance test at 200k results per day for one
recon (the size the audit performance tests use). If the per-status counts miss the statement budget there, they move
to a per-day count kept by the engine and the run's state changes; the table stays live.
`ponytail:` live counts per request, a stored daily count if production volume needs it.

## Rulings after the builder check (my calls)

- **Open link**: on rows of a lone item that is or was a break (`status` break or a break reason), the same items the
  Unmatch item page opens (`breakOf` in `break-resolve.ts`). Group rows and lone items that never broke show Explain
  only. No change to the Unmatch module.
- **Explain**: reuses `run-explain.tsx`. A group made by a run reads the spec of the version that run used; a manual or
  force group, and a lone item, read the published spec (their members and fields; no pass conditions to show).
- **Reversed groups** (`reversed_by` set) never show; their items show as their own rows by their current state.
- **Date**: a group by its `business_date` (the latest of its members'), a lone item by its own.
- **Volume test**: one recon with 200k results on one business date (page 1 and a deep page, sorted by status, plus
  the counts) must stay under the 5 s statement timeout; and the 31-day range at 30k a day (about 930k rows). If the
  31-day case misses, the range cap drops to 7 days first, before any stored count (cheapest fix, no engine work).
  Counts above the table are capped like list totals (`COUNT_CAP`, shown "100,000+").

## Constraints

- RLS: every read inside `withSpace`; a recon of another space is 404.
- Records of a recon can come from shared sources (`recordSpaces`); read them as Unmatch does.
- Simulation rows (`sim_run_id` not null) never show.
- Source fields have no sensitivity marking today; the screen shows what the Unmatch item page already shows to the same
  roles. If a source needs masking, that is a sources feature, not this one.
- Budget: the page under 300 kB first load (existing guard). Explain reuses `run-explain.tsx`, loaded on demand.
- Copy and colour rules: intent colours, status tone map, no machine names, red asterisk on required fields in the
  column setup dialog.
- Business dates are Asia/Jakarta, as everywhere.

## Decided by the owner

- Menu per space, one recon at a time, date range default today.
- Preview only; unmatch rows link to their Unmatch page for actions.
- One row per group (my recommendation, taken).
- Status, A and B as icons with a legend; Explain per row for each side's detail.
- Column setup on the recon menu, no approval.
- Approach 1.
- Server paging, 15 rows by default.

## My calls (correct me)

- Range max 31 days.
- Sort by status, business date, amount A, reference; not by source fields.
- Counts above the table, clickable as filters.
- Who edits the setup: config maker or space admin; History records each change.
- Default columns when no setup exists.
- A renamed or removed source field stays as a marked column, never dropped silently.
- No export this round.

## Left to the builder

- Exact icon per status from the icon set, within the tone rules.
- SQL shape (one query with a union of groups and lone items, or two pages merged) as long as paging is stable and the
  performance test holds.
- Contract names under `packages/shared/src/contracts/`.
