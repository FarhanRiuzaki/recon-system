# Report generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report templates per recon (Transactions / Grouped / Daily summary → CSV / Excel / PDF), versioned with approval for official ones, files made in the background after a run or on request, stored, downloaded with a trail.

**Architecture:** A new module `reports` (API `apps/api/src/modules/reports`, web `apps/web/src/features/reports`) owning three space tables; the worker gets a `reports.make` queue that reads items in keyset pages, masks, and streams to CSV, writes Excel with SheetJS, or prints HTML (DS tokens) to PDF with headless Chromium; the approvals module gains a `report_version` kind; the engine queues after-run files through the reports index.

**Tech Stack:** Bun 1.4.3, Elysia, Drizzle/PostgreSQL 18, pg-boss, SheetJS 0.20.3 (existing), `playwright-core` (new, exact) + Debian `chromium` (pinned) in the API image; Next 16, `@starterkit/ui` ds.

**Spec:** `docs/superpowers/specs/2026-11-25-report-generator-design.md` (read it first; sections "Settled after the builder check" and "Decided by the owner" are binding).

## Global Constraints

- AGENTS.md everywhere: module shape §13, route order §12, `SPACE_ACTION` lists only, RLS (`recon_enable_space_rls`) on every new table, Drizzle only, named imports, tests in `tests/{unit,integration}`, copy guide (English, sentence case), tokens only, five states per region, `next/dynamic` with `ssr: false`.
- Dependencies pinned exact; `playwright-core` is the only new npm package; xlsx allowed in `modules/reports` too (DEC-060, AGENTS §5 updated).
- Limits: range ≤ 92 calendar days; PDF ≤ 5,000 rows ("Use CSV or Excel for more than 5,000 rows"); Excel ≤ 1,048,576 rows per sheet; Test sample kept 24 h, always Masked; `REPORT_RETENTION_DAYS` default 400.
- Final = the date's day is signed off (`recon_days.signed_at` not null); else Not final.
- Full customer data: only on an official, approved version; downloaded only by `downloadFullReports` = `space_admin`, `reviewer`, `config_checker`.
- PDF concurrency 1 per worker, CSV/Excel 2; tibsdev: at most 2 heavy jobs.
- Activity actions: `report.template.create`, `report.version.save`, `report.version.submit`, `report.version.approve`, `report.version.reject`, `report.template.retire`, `report.make`, `report.download`.

## Review Focus

1. A run retried or its job redelivered: exactly one file per (template, run) — test in Task 5.
2. A Full-data file downloaded by an `operator`: 403, nothing streamed, no activity entry — test in Task 6.
3. Rows changing while a file is made on a Not final date: the file finishes, records `read_at`, never mixes two pages' copies of one item (keyset by item id) — test in Task 3.
4. A CSV cell starting `=`/`+`/`-`/`@` from a reference column: neutralized in the file — test in Task 4.
5. The worker dying mid-write: no half file is ever served; the row goes back to queued/failed, the temp file is swept — test in Task 5.

---

### Task 1: Shared contracts, permissions and kinds

**Files:**
- Create: `packages/shared/src/contracts/reports.ts`, `packages/shared/src/reports.ts` (zod-free limits)
- Modify: `packages/shared/src/spaces.ts` (SPACE_ACTION), `packages/shared/src/approvals.ts` (APPROVAL_KINDS), `packages/shared/src/contracts/results.ts` (ResultColumn `customer?: boolean`), `packages/shared/src/paging.ts`, `packages/shared/src/audit.ts`, `apps/web/scripts/emit-api-schemas.ts`
- Test: `packages/shared/src/reports.test.ts`, `packages/shared/src/spaces.test.ts`

**Interfaces — Produces:**
- `REPORT_KINDS = ["transactions","grouped","daily_summary"]`, `REPORT_FORMATS = ["csv","xlsx","pdf"]`, `REPORT_RANGE_MAX_DAYS = 92`, `PDF_ROWS_MAX = 5000`, `XLSX_ROWS_MAX = 1048576`, `fileNameOf(pattern: string, t: { recon: string; template: string; from: string; to: string }): string` (tokens `{recon}{template}{from}{to}{date}`; anything else stays literal; result made safe `[A-Za-z0-9._-]`).
- zod `ReportSpec` = `{ kind; rows: { statuses: ItemStatus[]; side: "a"|"b"|"both"; reasons: string[] }; columns: { key: string; header: string }[]; groups: string[] (≤2); totals: { fn: "count"|"sum"|"min"|"max"; column?: string }[]; output: { format; fileName: string; masking: "masked"|"full"; title?: string; subtitle?: string }; when: { afterRun: boolean; onRequest: boolean }; official: boolean }` with refinements: `masking "full"` needs `official`; `groups` only for `grouped`; at least one of `when`.
- DTOs `ReportTemplateDto`, `ReportVersionDto`, `ReportFileDto` (status `queued|making|ready|failed|removed`, `progress 0–100`, `final: boolean`, `dates: { date; final }[]`, `rows`, `size`, `masking`, `madeBy: { kind:"run"; runId } | { kind:"user"; userId; name }`, `fileVersion`), bodies `CreateReportTemplateBody { configId; name; start: "daily_summary"|"break_detail"|"matched_list"|"blank" }`, `SaveReportVersionBody { spec }`, `GenerateReportBody { templateId; from; to }`, `TestReportBody { from; to }`.
- SPACE_ACTION: `viewReports` (all roles), `editReports: ["config_maker"]`, `generateReports: ["space_admin","config_maker","operator","reviewer"]`, `downloadFullReports: ["space_admin","reviewer","config_checker"]`.
- APPROVAL_KINDS gains `"report_version"`.

- [ ] Step 1: failing tests: `fileNameOf("{recon}_{from}_{to}", {recon:"KSEI vs Core",…})` → `"KSEI-vs-Core_2026-11-01_2026-11-24"`; `{date}` with from=to → the date; unknown `{x}` literal; ReportSpec refuses `masking:"full"` without `official` ("Full customer data needs an official report."), `groups` on transactions, both `when` false; `mayDo(["operator"], "downloadFullReports")` false, `mayDo(["reviewer"], …)` true.
- [ ] Step 2: run `cd packages/shared && bunx vitest run src/reports.test.ts src/spaces.test.ts` → FAIL.
- [ ] Step 3: implement; register the contracts file in `emit-api-schemas.ts` (named + COMPOSED pages); `ACTION_LABEL` entries for the eight actions.
- [ ] Step 4: same command → PASS; `bun run typecheck`.
- [ ] Step 5: commit `feat(shared): report contracts, permissions and the report_version kind`.

### Task 2: API module, tables and template lifecycle

**Files:**
- Create: `apps/api/src/modules/reports/{index,controller,service,schema,rules}.ts`, migration `apps/api/drizzle/0073_reports.sql` (+ custom RLS `0074_reports_rls.sql`), `tests/integration/templates.test.ts`, `tests/unit/rules.test.ts`
- Modify: `apps/api/src/modules/index.ts`, `apps/api/src/modules/approvals/service.ts` (+ its index for approve/reject dispatch), `apps/api/test/architecture/boundaries.test.ts` (ownership list), `docs/api/README.md`, AGENTS.md §1/§12 ownership line
- Test: as above

**Interfaces — Consumes:** Task 1 contracts. **Produces:** tables `report_templates`, `report_template_versions`, `report_files` (columns per spec "Data", all with `space_id`, FK to `recon_configs(space_id,id)`); `reportTemplates`, `reportVersions`, `reportFiles` exported from the index; `activeVersion(tx, templateId): Promise<ReportVersionRow | null>`; `afterRunTemplates(tx, configId): Promise<{ templateId; versionId }[]>`; routes under `/v1/spaces/:spaceId/reports`: `GET templates` (page), `POST templates`, `GET templates/:id`, `GET templates/:id/versions` (page), `PATCH templates/:id/versions/:vid` (draft autosave), `POST …/versions/:vid/submit`, `POST templates/:id/retire`, `DELETE …/versions/:vid` (discard draft).

- [ ] Step 1: failing integration tests: create from `daily_summary` start → template + draft v1 filled (kind daily_summary, format pdf, masking masked); PATCH by `operator` 403 before body; PATCH on a non-draft 409 `invalid_state`; submit internal → active at once, activity `report.version.submit`; submit official → `waiting`, appears in `GET /approvals` with kind `report_version`; the maker approving their own → 409 `self_approval`; a checker approving → active, previous active `superseded`; rejected → draft editable again; retire → `retiredAt` set, `afterRunTemplates` excludes it; RLS: another space's template 404.
- [ ] Step 2: `cd apps/api && bun test src/modules/reports` → FAIL.
- [ ] Step 3: implement schema (`db:generate -- --name=reports`, then custom RLS file calling `recon_enable_space_rls` for each), service, controller in the §12 order, approvals arm like `source_version`; `rules.ts` holds `startSpec(start, kind)` (the three filled starting points) and `canSubmit(spec)`.
- [ ] Step 4: same → PASS; `bun test test/architecture`.
- [ ] Step 5: commit `feat(api): report templates with versions and approval`.

### Task 3: Rows, masking and the daily summary

**Files:**
- Create: `apps/api/src/modules/reports/rows.ts`, `mask.ts`, `summary.ts`, tests `tests/unit/mask.test.ts`, `tests/unit/summary.test.ts`, `tests/integration/rows.test.ts`

**Interfaces — Produces:**
- `maskValue(v: string): string` (keeps the last 4: `"1234567890"` → `"······7890"`; ≤4 chars → all dots).
- `customerKeys(resultColumns: ResultColumn[]): Set<string>` = `{"account_ref"}` ∪ columns with `customer: true`.
- `async function* reportRows(on: Tx, spaceId, configId, spec: ReportSpec, from, to, pageSize = 2000): AsyncGenerator<Record<string, string|number|null>[]>` — keyset by `(business_date, id)`, live items only (`sim_run_id is null`), `statuses/side/reasons` filters.
- `dailySummary(rows): DaySummary[]` per business date: `{ date, total, byStatus, matched, breaks, matchRate, amounts: { currency; matched; breaks }[], breaksByReason: { reason; count }[] }`.
- `groupRows(rows, groups, totals)` → rows with group header/total lines marked `{ _group: 1|2|"total" }`.

- [ ] Step 1: failing tests: maskValue cases; grouped totals (count, sum) over 2 levels; summary matchRate = matched/(total − not_required), 2 currencies kept apart; integration: 4,500 items over 2 dates read in pages of 2,000 → 4,500 rows, each id once even when an item is updated between pages (update a row after the first page in the test).
- [ ] Step 2: `bun test src/modules/reports/tests` → FAIL.
- [ ] Step 3: implement (Drizzle builder, `withSpace`).
- [ ] Step 4: → PASS.
- [ ] Step 5: commit `feat(api): report rows, masking and the daily summary`.

### Task 4: Writers — CSV, Excel, PDF

**Files:**
- Create: `apps/api/src/modules/reports/write-csv.ts`, `write-xlsx.ts`, `write-pdf.ts`, `pdf-html.ts`, `apps/api/src/modules/reports/assets/inter.woff2` (from `packages/ui` fonts), tests `tests/unit/write.test.ts`, `tests/integration/pdf.test.ts`
- Modify: `apps/api/Dockerfile` (install Debian `chromium` pinned through `BUILD_HTTP_PROXY`), `apps/api/package.json` (`playwright-core` exact), AGENTS.md §5 (xlsx in reports; playwright-core only in `modules/reports/write-pdf.ts`), `docs/decisions.md` DEC-060

**Interfaces — Consumes:** Task 3 rows. **Produces:** `writeCsv(rows: AsyncIterable<Row[]>, columns, out: string): Promise<{ rows; size; sha256 }>`; `writeXlsx(...)` same signature; `writePdf(html: string, out: string): Promise<{ size; sha256 }>`; `reportHtml(kind, data, meta: { title; subtitle?; recon; from; to; dates: {date;final}[]; masking }): string` (tokens CSS inlined from `packages/ui/src/styles/tokens.css` light; header repeated per page; footer "Page n of m · Final|Not final · Masked|Full customer data").

- [ ] Step 1: failing tests: CSV neutralizes `=SUM(1)` → `'=SUM(1)`, header uses `columns[].header`, sha256 matches the file; xlsx readable back by SheetJS with group total rows bold; over XLSX_ROWS_MAX → error "Excel holds at most 1,048,576 rows: use CSV."; `reportHtml` holds no external URL (`/https?:\/\//` absent) and every page footer text; PDF integration (skipped when no chromium binary): output starts with `%PDF`.
- [ ] Step 2: `bun test src/modules/reports/tests/unit/write.test.ts` → FAIL.
- [ ] Step 3: implement; Chromium launched with `--no-sandbox` off where possible, network blocked (`page.route("**", abort)` except the data URL), one browser per job, closed in `finally`.
- [ ] Step 4: → PASS; `docker compose … build api` succeeds with chromium.
- [ ] Step 5: commit `feat(api): report writers (CSV, Excel, PDF)`.

### Task 5: Making files — queue, storage, after run, Test, retention

**Files:**
- Create: `apps/api/src/modules/reports/make.ts`, `store.ts`, `jobs.ts`, tests `tests/integration/make.test.ts`
- Modify: `apps/api/src/kernel/jobs.ts` (`QUEUES.reportsMake: "reports.make"`, stately, key per file), `apps/api/src/worker.ts` (HANDLERS + concurrency), `apps/api/src/modules/engine/service.ts` (after the run's `succeeded` commit, non-simulation: `queueAfterRun(configId, runId, from, to)` through the reports index), `apps/api/src/db/janitor.ts` (`purgeReports`), `apps/api/src/kernel/config.ts` (`REPORT_RETENTION_DAYS` int 1–3650 default 400), `.env.example`s, `docker-compose.yml` (pass the key to api/worker)

**Interfaces — Produces:** `queueAfterRun(configId, runId, from, to): Promise<void>` (one file row per active after-run template, unique `(template_id, run_id)`); `requestFile(ctx, b: GenerateReportBody): Promise<ReportFileDto>`; `makeFile(on: Tx, fileId): Promise<void>`; `testFile(ctx, templateId, versionId, b: TestReportBody): Promise<{ sampleId; preview }>`; storage `<inbox root>/.reports/<id>.<ext>` written as `.<id>.part` then renamed; samples under `.reports/samples/`; `purgeReports(db)` removes files past retention (row → `removed`), samples past 24 h, `.part` leftovers past 1 h.

- [ ] Step 1: failing tests: a run's completion queues one file per after-run template; handling the job twice → one ready file (unique index); the same dates again → `fileVersion` 2, v1 kept; a signed-off date → `final: true`, an open one false; progress reaches 100; a 93-day request → 400 "A report covers at most 92 days. Pick a shorter range."; a PDF transactions request over 5,000 rows → failed with the sentence; a crash after writing half (handler throws mid-stream) → no file at the final path, row `failed`, `.part` swept by `purgeReports`; retention: a file older than 400 days → `removed`, its disk file gone; Test: masked even on a Full version, sample not listed in `GET files`.
- [ ] Step 2: `bun test src/modules/reports` → FAIL.
- [ ] Step 3: implement; activity `report.make` at queue time (user) or with the run as actor.
- [ ] Step 4: → PASS; `bun test src/modules/engine/tests/integration/runs.test.ts` still PASS.
- [ ] Step 5: commit `feat(api): report files made in the background, after a run or on request`.

### Task 6: Files list and download

**Files:** Modify `reports/controller.ts`, `service.ts`; Test `tests/integration/files.test.ts`

**Interfaces — Produces:** `GET …/reports/files` (page; filters recon, template, final, madeBy, status; facets), `GET …/reports/files/facets`, `GET …/reports/files/:id`, `GET …/reports/files/:id/download` (stream, `Content-Disposition: attachment; filename="<name>"`, activity `report.download`), `POST …/reports/files/:id/retry` (failed only), `GET …/reports/samples/:sampleId` (its maker only).

- [ ] Step 1: failing tests: a viewer downloads a masked file (200, bytes = stored, sha256 equal, activity entry with file id, no row data); an operator downloading a Full file → 403, no entry; another space's file 404; a `removed` file → 409 "This report was removed after 400 days."; facets count Final/Not final; sample by another user 404.
- [ ] Step 2–4: run/implement/pass (`bun test src/modules/reports`).
- [ ] Step 5: commit `feat(api): report files list and download with a trail`.

### Task 7: Web — Reports page (Files, Templates, Generate)

**Files:**
- Create: `apps/web/src/features/reports/{reports-page.tsx,files-table.tsx,templates-table.tsx,generate-dialog.tsx,use-reports.ts,report-text.ts,shapes.ts}`, `apps/web/src/app/(main)/spaces/[spaceId]/reports/{page.tsx,loading.tsx}`, `…/reports/templates/page.tsx`, tests `features/reports/report-text.test.ts`, `generate-dialog.test.ts`
- Modify: `lib/shared/queries.ts`, `lib/server/prefetch.tsx`, `lib/shared/nav.ts` (space group "Reports", icon), `components/shell/nav-icon.tsx`, `lib/shared/prefs.ts` (VIEW_PAGES), `components/route-shapes.ts`, copy guide navigation labels

**Interfaces — Consumes:** Task 6 routes. **Produces:** `ReportsFiles({ spaceId, configId? })` and `ReportsTemplates({ spaceId, configId? })` exported from `features/reports` for reuse inside the reports routes only.

- [ ] Step 1: failing tests: `statusText(file)` → "Making… 62%", "Ready", "Failed"; `finalText` → "Final" / "Not final"; Generate dialog: a range with 3 open dates shows "3 of these dates aren't closed yet: the report is marked Not final."; 93 days → Generate blocked with the sentence.
- [ ] Step 2–4: `cd apps/web && bunx vitest run src/features/reports` FAIL → implement (server DataTable, FilterLayout, SavedViewsMenu, ColumnsMenu, download link to `/api/spaces/<id>/reports/files/<id>/download`, Files polls every 3 s while any row is queued/making) → PASS; `bun run typecheck`.
- [ ] Step 5: commit `feat(web): the Reports page`.

### Task 8: Web — template page and the draft Wizard

**Files:**
- Create: `features/reports/{template-page.tsx,new-template.tsx,draft-wizard.tsx,steps/{content,columns,output,test,review}.tsx,spec-model.ts}`, routes `…/reports/templates/[templateId]/{page,loading}.tsx`, `…/versions/[versionId]/{page,loading}.tsx`, tests `spec-model.test.ts`, `draft-wizard.test.ts`

**Interfaces — Produces:** `stepProblems(spec, step): string | null` for the Wizard marks; autosave through the recon's `saveQueue` pattern (copy, not import: sibling feature).

- [ ] Step 1: failing tests: `stepProblems` — no columns → "Pick at least one column."; Full masking without official → "Full customer data needs an official report."; PDF + transactions shows "PDFs hold at most 5,000 rows" note; new template cards: four `InteractiveCard`s (Daily summary, Break detail, Matched list, Blank); Test step renders StatTile/BreakdownCard for daily summary, a table of 50 rows otherwise, and a "Download sample" link.
- [ ] Step 2–4: FAIL → implement (Wizard + "Setup progress" panel, header Saved/Saving…/Not saved · Retry, Discard draft in ⋯, VersionLayout on the versions page, SortableList for columns, `next/dynamic` for the Wizard) → PASS.
- [ ] Step 5: commit `feat(web): report template page and draft wizard`.

### Task 9: Web — shortcuts from recon and run, customer flag

**Files:** Modify `features/recon/recon-detail.tsx` (tab "Reports" linking `…/reports?recon=<id>` route views), `features/recon/run-page.tsx` ("Reports made by this run (N)"), `features/recon/result-columns-editor.tsx` (switch "Customer data" per column); API: `GET …/reports/files?run=<id>` filter. Tests: `features/recon/result-columns-model.test.ts` (customer flag kept), `apps/api/…/files.test.ts` (run filter).

- [ ] Step 1–4: failing tests → implement (the recon tab is a route under `spaces/[spaceId]/recons/[configId]/reports` rendering the reports feature's components from the reports route segment's page: no sibling-feature import) → PASS.
- [ ] Step 5: commit `feat(web): reports from the recon and its runs; customer data columns`.

### Task 10: Docs, check, deploy

- [ ] Step 1: `bun run api:schemas`; endpoint table rows; DEC-060 (reports module, Chromium PDF, xlsx in reports); AGENTS §1 module lists and §12 ownership.
- [ ] Step 2: `PATH=/root/.local/bun-1.4.3:$PATH bun run check` with `TEST_PERF_FACTOR=1.5` → all green (host load can time out unrelated tests: rerun them alone).
- [ ] Step 3: deploy tibsdev (build api worker web migrate; migrate; up); smoke: create Daily summary from KSEI recon, Test, submit, run → file Ready → download; screenshots to the owner.
- [ ] Step 4: commit `docs: report generator`, push.
