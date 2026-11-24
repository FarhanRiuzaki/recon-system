# Operation result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A space menu "Operation result": one recon's results (groups and lone items) for a business-date range, one
row per result, overall and per-side status icons, configurable columns set on the recon page without approval.

**Architecture:** Live query in the `engine` module over `match_groups`/`match_members`/`recon_items`/`records`, the
latest `approval_requests` and `action_runs` (plus `posting_group_items`); one pure status function in
`packages/shared` used by the SQL-side mapping and the screen. The column setup is a small non-versioned table owned by
the `recon` module. The web gets a `results` feature (list page) and a panel in the recon Configuration tab.

**Tech Stack:** Bun + Elysia + Drizzle (PG18, RLS via `withSpace`), zod contracts, Next 16 BFF, React Query,
`@starterkit/ui/ds` (`DataTable`, `FilterLayout`, `Panel legend`, `StatusChip`, `Stepper` not needed).

**Spec:** `docs/superpowers/specs/2026-11-24-operation-result-design.md` (read it first; its tables of statuses and its
"Rulings after the builder check" are binding).

## Global Constraints

- Every list pages through `pageQuery`; page size 15 | 25 | 50 | 100, **default 15**; `totalCapped` past `COUNT_CAP`.
- Business-date range: default today (Asia/Jakarta), at most 31 days; a wider range is 400.
- Simulation rows (`sim_run_id` not null) and reversed groups (`reversed_by` not null) never show.
- Records may come from shared sources: read them as `break-queue.ts` does (`recordSpaces`).
- Status colours only through `statusChip`/`STATUS_TONE` (`apps/web/src/lib/shared/categories.ts`); legend only via
  `Panel legend={…}` (AGENTS.md §7).
- No machine names on screen; copy rules of `docs/standards/copy-guide.md`; intent colours (create green, edit blue,
  delete red).
- Column setup: at most 20 columns; config maker or space admin edits; any space role reads; each save
  `recordActivity` action `recon.result_columns` with before/after; no version, no approval.
- AGENTS.md §12 route order, §12 Data (RLS on the new table via `recon_enable_space_rls`), §13 web steps (nav entry,
  `VIEW_PAGES`, `ROUTE_SHAPES`, `loading.tsx`, `Prefetch`, query keys in `queries-recon.ts`).
- First-load JS ≤ 300 kB per route; Explain loads through `next/dynamic` with `ssr: false`.
- Never run Playwright/E2E. `bun run check` before each final commit.

## Review Focus

1. A posted item whose grouped posting is still in an open group → "Posting in progress", never "Posted" (Task 1 test,
   Task 3 integration test with a `posting_group_items` row and no run).
2. A group with mixed currencies on one side → Amount cell "Mixed", not a summed number (Task 3 test).
3. A source field renamed after the setup was saved → column kept, cells "Field not in the source", setup marks it
   (Task 2 + Task 5 tests).
4. A recon of another space, or a configId that is not a UUID → 404 on list, counts and setup (Task 2/3 tests).
5. `dateTo` before `dateFrom`, or a range of 32 days → 400 before the guard (Task 1 contract test, Task 3 route test).

---

### Task 1: Shared contracts and the status function

**Files:**
- Create: `packages/shared/src/contracts/results.ts`, `packages/shared/src/results.ts`, `packages/shared/src/results.test.ts`
- Modify: `packages/shared/src/paging.ts` (`RESULT_SORTS`), `packages/shared/src/audit.ts` (`ACTION_LABEL["recon.result_columns"] = "Operation result columns changed"`), `packages/shared/src/filter-selection.ts` (`MULTI_FILTER_KEYS` += `"result"`, `"sideA"`, `"sideB"`), `apps/web/scripts/emit-api-schemas.ts` (import + `named` + `COMPOSED` `ResultPage`)

**Interfaces — Produces:**
- `RESULT_STATUSES = ["posting_failed","posting_in_progress","posting_skipped","waiting_approval","posted","written_off","adjusted","closed","force_matched","matched_by_hand","matched_late","suggested","matched","unmatch","waiting_counterpart"] as const` and `RESULT_STATUS_LABEL` (the spec table's words) in `packages/shared/src/results.ts`.
- `SIDE_STATES = ["in_group","suggested","unmatch","open","closed","none"] as const`.
- `resultStatus(x: { groupKind: GroupKind | null; resolution: Resolution | null; itemStatus: ItemStatus | null; proposed: boolean; pendingRequest: boolean; posting: PostingStatus | null }): ResultStatus` — first that holds, in the spec table's order. `posting` = the latest posting run's status (`"grouped"` while it waits in an open group).
- `RESULT_RANGE_MAX_DAYS = 31`, `RESULT_COLUMNS_MAX = 20`.
- `RECON_INFO_FIELDS = ["businessDate","pass","reason","assignee","postingStatus","bankReference","resolutionNote","resolvedAt"] as const`.
- Contracts (`contracts/results.ts`):
  - `ResultColumn = { kind: "a" | "b"; field: string; label: string } | { kind: "recon"; field: ReconInfoField; label: string }`
  - `ResultColumnsDto = { columns: ResultColumn[]; isDefault: boolean; missing: { kind: "a"|"b"; field: string }[]; updatedAt: string | null }`; `ResultColumnsBody = { columns: ResultColumn[] }` (max 20, labels trimmed 1–60, no duplicate kind+field).
  - `ResultListQuery = ListQuery.extend({ sort: sortParam(RESULT_SORTS), dateFrom: isoDate, dateTo: isoDate, result: filterSelection(z.enum(RESULT_STATUSES)).optional(), sideA: filterSelection(z.enum(SIDE_STATES)).optional(), sideB: …, })` with a refine: `dateFrom ≤ dateTo` and span ≤ 31 days. `q` = reference search.
  - `ResultSide = { state: SideState; count: number }`; `ResultCell = { value: string | null; many: number | null; missing?: true }` (`many` = "N values").
  - `ResultRowDto = { id: string; kind: "group" | "item"; businessDate: string; status: ResultStatus; a: ResultSide; b: ResultSide; cells: Record<string, ResultCell>; openItemId: string | null; explain: { groupId: string | null; itemId: string | null; runId: string | null } }` (cell key = `${kind}:${field}`).
  - `ResultCountsDto = { counts: Partial<Record<ResultStatus, number>>; capped: boolean }`.
- `RESULT_SORTS = ["businessDate","status","amountA","ref"] as const`.

- [ ] **Step 1: Write the failing tests** in `packages/shared/src/results.test.ts`:
  - `resultStatus` over every combination of `groupKind × resolution × itemStatus × proposed × pendingRequest × posting` returns a member of `RESULT_STATUSES` (no throw); and the pinned cases:
    - `{resolution:"POSTED", posting:"grouped"}` → `posting_in_progress`; `posting:"failed"` → `posting_failed`; `posting:"no_rule"` → `posting_skipped`; `posting:"posted"` and `posting:null` → `posted`.
    - `{groupKind:"auto", pendingRequest:true}` → `waiting_approval`; `{groupKind:"force"}` → `force_matched`; `{itemStatus:"break"}` → `unmatch`; `{itemStatus:"break", proposed:true}` → `suggested`; `{itemStatus:"open"}` → `waiting_counterpart`; `{resolution:"ADJUSTED"}` → `adjusted`; `{itemStatus:"closed"}` → `closed`.
  - `ResultListQuery.safeParse` refuses `dateTo < dateFrom` and a 32-day span, takes 31 days.
- [ ] **Step 2:** `cd packages/shared && bunx vitest run src/results.test.ts` → FAIL (module missing).
- [ ] **Step 3:** implement the files above.
- [ ] **Step 4:** same command → PASS; `bun run api:schemas`.
- [ ] **Step 5:** commit `feat(shared): Operation result contracts and the result status`.

### Task 2: Column setup API (recon module)

**Files:**
- Modify: `apps/api/src/modules/recon/schema.ts` (table `recon_result_columns`: `space_id uuid`, `config_id uuid` PK with space, `columns jsonb not null`, `updated_by uuid`, `updated_at timestamptz`), `apps/api/src/modules/recon/controller.ts`, `apps/api/src/modules/recon/service.ts` (or a new `result-columns.ts` in the module), `apps/api/src/modules/recon/index.ts` (export `resultColumnsOf` for the engine), `AGENTS.md` §12 ownership line (`recon` … `recon_result_columns`), `docs/api/README.md` endpoint table.
- Create: migration via `cd apps/api && bun run db:generate -- --name=result_columns`, then append `select recon_enable_space_rls('recon_result_columns');`
- Test: `apps/api/src/modules/recon/tests/integration/result-columns.test.ts`

**Interfaces — Produces:**
- `GET /v1/spaces/:spaceId/recons/:id/result-columns` → `ResultColumnsDto` (any space role).
- `PUT /v1/spaces/:spaceId/recons/:id/result-columns` body `ResultColumnsBody` → `ResultColumnsDto` (`config_maker`, `space_admin`); empty `columns` = back to default (row deleted).
- `resultColumnsOf(tx, spaceId, configId): Promise<{ columns: ResultColumn[]; isDefault: boolean; fields: { a: Set<string>; b: Set<string> } }>` — default when no row: `a:ref`, `a:amount`, `b:ref`, `b:amount`, `recon:businessDate` (ref/amount are `records.ext_ref`/`amount_minor`, keys `"ref"`/`"amount"`); `fields` = the field keys of the source each side of the **published** version reads (published source version), used for `missing`.

- [ ] **Step 1: Failing tests:** default when unset (`isDefault: true`, the five columns); PUT as config maker saves, GET returns it, one activity row `recon.result_columns` with before/after; PUT `[]` returns to default; PUT as operator 403; 21 columns 400; duplicate column 400; a column whose field the source no longer has → listed in `missing`; another space's recon 404; non-UUID id 404; a recon with no published version → GET 200 default, PUT 409 `invalid_state` ("Publish a version first").
- [ ] **Step 2:** `cd apps/api && bun test src/modules/recon/tests/integration/result-columns.test.ts` → FAIL.
- [ ] **Step 3:** implement; migration applied by the test preload.
- [ ] **Step 4:** same → PASS; `bun test test/architecture` → PASS (ownership, RLS, conformance).
- [ ] **Step 5:** commit `feat(api): Operation result column setup per recon, no approval`.

### Task 3: Results list and counts API (engine module)

**Files:**
- Create: `apps/api/src/modules/engine/results.ts`, test `apps/api/src/modules/engine/tests/integration/results.test.ts`, perf test `apps/api/src/modules/engine/tests/integration/results-volume.test.ts`
- Modify: `apps/api/src/modules/engine/controller.ts`, `docs/api/README.md`, `NON_LIST_GETS` in the conformance test for `/counts`.

**Interfaces — Consumes:** Task 1 contracts and `resultStatus`; Task 2 `resultColumnsOf`.
**Produces:**
- `GET /v1/spaces/:spaceId/recons/:configId/results` (`ResultListQuery`) → `Page<ResultRowDto>`; any space role.
- `GET /v1/spaces/:spaceId/recons/:configId/results/counts` (same query) → `ResultCountsDto`, counts with the `result` filter left out (facet rule).

Approach: rows = live groups of the config whose `business_date` is in range (not reversed, not sim) **union** lone
items (`recon_items` not in a live group) whose `business_date` is in range; page/sort over that union with
`pageQuery`; then fill cells only for the page's rows (members' records `attrs`, item fields, latest pending request,
latest posting run per item: own `action_runs` kind posting, else `posting_group_items` → `posting_groups` (open =
`grouped`) → its `run_id`). Status computed in SQL with the same order as `resultStatus` for filter/sort/count, and
the TS `resultStatus` for the page's rows; a test asserts both agree on every fixture row. Cells per the spec
("Cells of a group with several records on a side"): amount = side sum, "Mixed" when currencies differ (`value:"Mixed"`);
other fields = value if all equal else `many`. `openItemId` = the lone item's id when it is or was a break
(`status = 'break'` or `break_reason is not null`).

- [ ] **Step 1: Failing tests** (`results.test.ts`, fixtures like `break-summary.test.ts`): an auto pair → one row `matched`, a/b `in_group` count 1; a 1:3 force group → one row `force_matched`, b count 3, amount B = sum, a differing source field → `many: 3`; mixed currencies → "Mixed"; a lone break → `unmatch`, `openItemId` set; posted with open group → `posting_in_progress`; posted with run failed → `posting_failed`; reversed group absent and its items as lone rows; sim rows absent; default page size 15; `result=unmatch` filters; counts leave their own filter out; `q` finds by reference on either side; range 32 days 400; other space 404; SQL status equals `resultStatus` for every row.
- [ ] **Step 2:** `cd apps/api && bun test src/modules/engine/tests/integration/results.test.ts` → FAIL.
- [ ] **Step 3:** implement `resultPage(ctx, configId, q)` and `resultCounts(ctx, configId, q)` in `results.ts`, routes in the controller.
- [ ] **Step 4:** PASS. Then `results-volume.test.ts`: insert 200k results (mix of pairs and breaks) on one date for one recon; page 1 and `page=1000&pageSize=100`-capped deep page sorted by status, and counts, each under the 5 s statement timeout; then 30k/day × 31 days, same checks. If the 31-day case fails, set `RESULT_RANGE_MAX_DAYS = 7` (Task 1) and note it in the ledger as a ruling.
- [ ] **Step 5:** commit `feat(api): Operation result rows and counts per recon`.

### Task 4: Operation result page (web `results` feature)

**Files:**
- Create: `apps/web/src/features/results/{results-page.tsx, result-columns.tsx, result-model.ts, result-model.test.ts, shapes.ts}`, `apps/web/src/app/(main)/spaces/[spaceId]/results/{page.tsx,loading.tsx}`, `apps/web/src/app/(main)/results/page.tsx` (entry redirect like `app/(main)/breaks/page.tsx`)
- Modify: `apps/web/src/lib/shared/nav.ts` (`NavIcon` += `"results"`, entry `{ href: "/results", label: "Operation result", icon: "results", shortcut: <first free "G x">, group: "work", perm: null, space: "results" }`, `SPACE_PAGES` += `"results"`), `components/shell/nav-icon.tsx`, `lib/shared/queries-recon.ts` (`RESULTS(spaceId, configId)` table def with `facets`-like counts read, `RESULT_COLUMNS` key), `lib/server/prefetch.tsx` (`reads.results`), `lib/shared/prefs.ts` (`VIEW_PAGES`), `components/route-shapes.ts`, `docs/standards/copy-guide.md` (nav label).

**Interfaces — Consumes:** Task 1 types; Task 2/3 endpoints via `/api/...`.
**Produces:** `resultIcon(status: ResultStatus): { icon: IconName; chip: StatusChipData }` and `sideIcon(s: ResultSide)` in `result-model.ts` (tone per the spec table; icons from `packages/ui/src/ui/icons.ts` only).

Screen: `PageHeader` "Operation result"; recon picker (`Select`, recons with a published version, `?recon=` in the URL;
first recon by name when absent), `DateRangeControl` for business date (default today), `FilterLayout` with
`FilterChecks` for Status (with counts from `/counts`), Side A, Side B, and `FilterSearch` "Reference"; counts strip
above the table (each a toggle of the Status filter); `Panel` with `legend={…}` listing every `RESULT_STATUS_LABEL` with
its icon; server `DataTable` (default 15) with fixed columns Status, A, B, then the configured columns, then Action
(Explain button; Open link to `/spaces/{id}/breaks/{openItemId}` when set); `ColumnsMenu` + `SavedViewsMenu`; five
states. Explain (a feature may not import the recon feature's `run-explain.tsx`): a `Dialog` in this feature, loaded
with `next/dynamic` (`ssr: false`), listing each side's members (reference, amount, currency, business date, the
configured source fields) from `GET …/results/{rowId}/members` (add it in Task 3: `{ a: Member[]; b: Member[] }`,
at most 100 per side), plus, when `explain.runId` is set, a link "See how the run matched it" to
`/spaces/{id}/recons/{configId}/runs/{runId}`. Ruling: the pass-condition view stays on the run page (spec said
"reuse run-explain"; the layering rule forbids it here).

- [ ] **Step 1: Failing tests** in `result-model.test.ts`: every `RESULT_STATUSES` value has an icon and a chip whose tone matches the spec table (green/red/amber/blue/grey); `sideIcon({state:"in_group",count:3})` label "3 records"; a cell `{many:3}` renders "3 values", `{missing:true}` "Field not in the source".
- [ ] **Step 2:** `cd apps/web && bunx vitest run src/features/results` → FAIL.
- [ ] **Step 3:** implement the model, then the page and routes.
- [ ] **Step 4:** PASS; `bun run check` (architecture tests: nav, VIEW_PAGES, route shapes, page anatomy, legend only in Panel).
- [ ] **Step 5:** commit `feat(web): Operation result page`.

### Task 5: Column setup on the recon page

**Files:**
- Create: `apps/web/src/features/recon/result-columns-panel.tsx`, `apps/web/src/features/recon/result-columns-model.ts` + test
- Modify: `apps/web/src/features/recon/recon-detail.tsx` (Configuration tab, after `SpecView`)

**Interfaces — Consumes:** Task 2 endpoints, Task 1 types.
**Produces:** `columnChoices(fields: { a: SourceField[]; b: SourceField[] }): { value: string; label: string; group: "Side A" | "Side B" | "Recon" }[]`.

Panel "Operation result columns" (description "What the Operation result table shows for this recon; changes apply
now, no approval"), read view = the columns in order with a "Field not in the source" chip on missing ones; Edit
(blue, `edit` variant) opens an editor in place: add column (green), pick field (grouped Side A / Side B / Recon),
heading input, move up/down, remove (red X), Save / Cancel, "Back to default" (secondary). Editable for config maker
and space admin; others see the read view only. Result toast; failure inline.

- [ ] **Step 1: Failing tests** in `result-columns-model.test.ts`: choices grouped and labelled from the sources' field labels; a duplicate pick is refused with "Already a column"; 21st add refused with "At most 20 columns".
- [ ] **Step 2:** `cd apps/web && bunx vitest run src/features/recon/result-columns-model.test.ts` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** PASS; `bun run check`; build + `bun run budget` (recon page now 294.7 kB: load the editor with `next/dynamic` if it crosses 300).
- [ ] **Step 5:** commit `feat(web): Operation result columns on the recon page`.
