# Report Designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 report template editor (start cards, 5-step wizard, fixed kinds) with a free report designer: data from a recon joined to its sources, any columns by drag and drop, per-column content and format, optional sections, one design to CSV/Excel/Text fixed-width/PDF.

**Architecture:** Spec v2 (`v: 2`) is a free document model in `packages/shared`. One server pipeline (dataset reader → row filter → cell renderer with CEL formulas, masking and formats → section renderer → writer) serves both the worker's file and a new preview endpoint, so the preview equals the file. The web designer is a three-pane page in the DS whose edits are pure functions on the spec, autosaved by the v1 serial saver. Queue, files, downloads, approval, after-run, retention stay v1.

**Tech Stack:** Bun 1.4.3, Elysia, Drizzle, PostgreSQL 18, Next 16, Zod, `@marcbachmann/cel-js` 8.0.0 (ingest env), SheetJS, playwright-core 1.63.0 + Chromium, `@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0, Vitest/bun test.

**Spec:** `docs/superpowers/specs/2026-11-26-report-designer-design.md` (read the "Rules settled after the builder check" section). v1: `docs/superpowers/specs/2026-11-25-report-generator-design.md`.

## Global Constraints

- A template belongs to one recon (`config_id`); no source-only reports.
- Datasets: `results` | `items` | `recap`. Source detail = side fields `a:<field>` / `b:<field>` where field is a core field or `attrs.<name>` (engine `FIELD_REF`).
- Every section optional: title, header block, column headers, totals, footer. "Data only" = all off.
- Customer data: `a|b:account_ref` always; recon result columns flagged `customer`; source attributes flagged customer in the source mapping (new, Task 6). A formula naming a customer field is customer data. Preview always masked. Mask = v1 `maskValue` (last 4 kept).
- `masking: "full"` only when `official: true` (v1 rule kept). `official`, `when { afterRun, onRequest }` kept.
- Limits kept: range 92 days, PDF 5,000 rows, Excel 1,048,576 rows; new: columns ≤ 60, header lines ≤ 20, formula length ≤ 1000 (`MAX_EXPR_LENGTH`), groups ≤ 3.
- Number formats: decimals 0–4; thousands `.` | `,` | `none`; negative `minus` | `paren` | `trailing`; prefix/suffix ≤ 10 chars. Date patterns exactly: `dd/MM/yyyy`, `yyyy-MM-dd`, `yyyyMMdd`, `ddMMyyyy`, `dd MMM yyyy`, `dd-MM-yyyy`, `MM/dd/yyyy`. Text case: `as_is` | `upper` | `lower`.
- CSV/Text: header block and footer are the first and last lines of the file (header record, trailer record). Group/subtotal lines in CSV/Text only when `output.groupLines` (default false).
- Copy: English UI (Console rule), the copy-guide voice; no "Start from" anywhere.
- AGENTS.md rules: conformance (paged lists, logged changes, literal route paths), module boundaries (import other modules through their index), DS-only UI, button intents.
- Tests on tibsdev: `PATH=/root/.local/bun-1.4.3:$PATH`, `apps/api/.env` with `recon_system_dev` DB and `TEST_PERF_FACTOR=1.5`; full check `bun run check`.

## Review Focus

1. A v1 template version opened after deploy: it must load in the designer as an equivalent v2 spec, and its next after-run file must keep the same columns (Task 1 `fromV1` test + Task 3 make test on a v1 row).
2. A formula over an account (`a.account_ref.substring(0, 6)`) in a masked report: the cell must be masked (Task 2 test).
3. Text fixed-width with a value longer than its width, a negative amount and `pad: "0"`: cut to width, sign kept in front of the zeros (`-0001500`) (Task 2 test).
4. Data only on every format: CSV without a header line, Excel with no title rows, PDF with just the table, TXT with only data lines (Task 4 golden tests).
5. A column whose field no longer exists in the recon's sources (attribute removed): preview and file show the cell empty and the designer marks the column "Field not in the data" instead of failing (Task 3 test, Task 8 test).

---

### Task 1: Spec v2 contract, v1 conversion, shared formatter

**Files:**
- Modify: `packages/shared/src/contracts/reports.ts` (ReportSpec → v2; `ReportSpecV1` kept private for conversion; Create/Save bodies)
- Modify: `packages/shared/src/reports.ts` (new limits, `DATE_PATTERNS`, `REPORT_DATASETS`; drop `REPORT_KINDS`, `REPORT_STARTS`)
- Create: `packages/shared/src/report-format.ts` (pure formatter, used by the API only; web shows server-formatted cells)
- Create: `packages/shared/src/report-spec.ts` (`fromV1`, `emptySpec`, `specFields`)
- Test: `packages/shared/src/report-format.test.ts`, `packages/shared/src/report-spec.test.ts`

**Interfaces:**
- Produces:
  - `ReportSpec` (Zod, `v: z.literal(2)`), shape exactly as the spec's "Spec v2" block plus `official`, `when`; column `id: z.string().regex(/^c[0-9a-z]{1,12}$/)`; `content` discriminated on `kind: "field" | "formula" | "text" | "rownum"` (`field: { ref, fallback? }`, `formula: { cel }`, `text: { text ≤ 200 }`); `format` discriminated on `kind: "number" | "date" | "text" | "auto"`; `layout { align: "l"|"c"|"r", width: 1..200, pad: " " | "0" }`; `highlight?: { when: "not_zero"|"negative"|"empty"|"equals", value?: string, style: "red"|"bold" }`; `rows.filters: [{ ref, op: "is"|"is_not"|"any_of"|"contains"|"empty"|"not_empty"|"gt"|"lt", value: string[] }]`; `groups: ref[] ≤ 3`; `totals { on, perGroup, columns: { [columnId]: "sum"|"count" } }`; `sections { title: { on, text ≤ 200 }, header: { on, lines: [{ label ≤ 80, value: { kind: "text", text } | { kind: "field", ref } | { kind: "count" } | { kind: "sum", ref } }] }, columnHeaders: boolean, footer: { on, stamp: boolean, pageNumbers: boolean, text ≤ 200 } }`; `output { format, csv: { delimiter: ","|";"|"\t"|"|", quote: "auto"|"all" }, lineEnding: "crlf"|"lf", encoding: "utf8"|"ascii", fileName ≤ 120 with tokens {name} {from} {to} {version}, masking, groupLines: boolean }`.
  - `parseStoredSpec(json: unknown): ReportSpec` — v2 as is; v1 (no `v`) through `fromV1`.
  - `fromV1(s: ReportSpecV1): ReportSpec` — transactions → results with its columns; grouped → groups + totals; daily_summary → `recap` with columns date, results, matched, breaks, match rate; `rows.statuses` → filter `{ ref: "recon:status", op: "any_of" }`; `side` → filter on `recon:side`; reasons → filter `recon:reason any_of`; output/official/when copied; masking kept.
  - `emptySpec(): ReportSpec` — results, no columns, all sections on, csv, masked, `official: false`, `when { afterRun: false, onRequest: true }`.
  - `formatCell(v: string | number | bigint | null, f: ColumnFormat): string` and `fitWidth(s: string, l: Layout, numeric: boolean): string` (Text fixed-width: cut to width, pad side by align, numeric zero padding keeps `-` first).
- Consumes: `RESULT_STATUSES`, `FIELD_REF` from shared.

- [ ] **Step 1: Write failing tests**
  - `report-format.test.ts`: `formatCell(-1234567.891, { kind:"number", decimals:2, thousands:".", negative:"paren", prefix:"Rp ", suffix:"" })` → `"(Rp 1.234.567,89)"`; thousands `,` → `"-1,234,567.89"` with minus; `none` → `"1234567.89"`; `trailing` → `"1.500-"`; date `"2026-11-25"` with each of the 7 patterns (`dd MMM yyyy` → `"25 Nov 2026"`); text upper; null → `""`; `fitWidth("-1500", { align:"r", width:8, pad:"0" }, true)` → `"-0001500"`; `fitWidth("ABCDEFGHIJ", { align:"l", width:4, pad:" " }, false)` → `"ABCD"`.
  - `report-spec.test.ts`: `fromV1` of each v1 start (`startSpec` outputs from v1 `rules.ts`, copied as fixtures) equals expected v2 objects; `parseStoredSpec(v2)` round-trips; `ReportSpec` rejects `masking:"full"` with `official:false` ("Only an official report shows customer data in full."), duplicate column ids, a filter on an unknown op.
- [ ] **Step 2: Run** `cd packages/shared && bunx vitest run src/report-format.test.ts src/report-spec.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the contract, `fromV1`, `parseStoredSpec`, `emptySpec`, `formatCell`, `fitWidth`. Amount fields are minor units in the data; the formatter takes the major value: the reader divides by 10^exponent of the row's currency, using the exponent the engine already uses to show amounts (find its helper; do not add a second table).
- [ ] **Step 4: Run** the same command — Expected: PASS; then `bunx tsc --noEmit -p packages/shared`.
- [ ] **Step 5: Commit** `feat(reports): spec v2 contract, v1 conversion, cell formatter`

### Task 2: Formulas and the cell renderer (API)

**Files:**
- Create: `apps/api/src/modules/reports/formula.ts`
- Create: `apps/api/src/modules/reports/cells.ts`
- Modify: `apps/api/src/modules/ingest/cel.ts` (export a factory for an environment with extra variables; no behaviour change for derive)
- Test: `apps/api/src/modules/reports/tests/unit/cells.test.ts`

**Interfaces:**
- Produces:
  - `compileFormula(cel: string): { ok: true; run: (vars: FormulaVars) => unknown; refs: string[] } | { ok: false; error: string }` — variables `a`, `b`, `recon` (maps from field name to value; amounts as `double` in major units, other numbers as `double`, text as string), the ingest allowlist and LIMITS; `refs` = the `a:x`/`b:x`/`recon:x` refs the expression reads (from the AST), used for customer propagation.
  - `type DataRow = { date: string; values: Record<string, string | number | null> }` — keys are refs (`a:ext_ref`, `a:attrs.member`, `recon:status` …); numbers already major units.
  - `renderRow(spec, row: DataRow, index: number, ctx: { customer: Set<string>; compiled: Map<string, Compiled> }): { cells: string[]; raw: (string|number|null)[]; problems?: string[] }` — content per kind, fallback when empty, formula (error → cell `"#ERR"` and a problem naming the column), masking (`ctx.customer` has the ref, or the formula's refs intersect it, and `spec.output.masking === "masked"`), `formatCell`.
  - `customerOf(spec, base: Set<string>): Set<string>` — column ids whose cells are customer data.
- Consumes: Task 1 `formatCell`, `ReportSpec`; v1 `maskValue`.

- [ ] **Step 1: Failing tests** in `cells.test.ts`: formula `a.amount - b.amount` → `150` formatted per column; formula reading `a.account_ref` in a masked spec → masked cell (Review Focus 2); formula syntax error → `compileFormula` returns `{ ok:false, error }` naming the position; unknown function (`matches`) refused; fallback used when `a:ext_ref` empty; `rownum` counts from 1; a ref missing from the row → `""` (Review Focus 5); `fitWidth` applied only when `output.format === "txt"`.
- [ ] **Step 2: Run** `cd apps/api && PATH=/root/.local/bun-1.4.3:$PATH bun test src/modules/reports/tests/unit/cells.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `formula.ts` (environment built once per spec from the ingest factory), `cells.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(reports): formulas and cell rendering`

### Task 3: Dataset readers, filters, sections; make + preview on v2

**Files:**
- Modify: `apps/api/src/modules/reports/rows.ts` (readers by dataset)
- Modify: `apps/api/src/modules/engine/results.ts` (export `reportItemRows`: keyset pages of `recon_items` joined to `records`, live only, same `after`/`limit` shape as `reportResultRows`)
- Modify: `apps/api/src/modules/engine/index.ts` (export it)
- Modify: `apps/api/src/modules/reports/summary.ts` → recap reader: one row per date and currency
- Create: `apps/api/src/modules/reports/sections.ts`
- Modify: `apps/api/src/modules/reports/make.ts`, `service.ts`, `rules.ts`, `controller.ts`, `files.ts` (spec via `parseStoredSpec`; create without `start`; Test unchanged; new preview route)
- Test: `apps/api/src/modules/reports/tests/integration/rows.test.ts`, `make.test.ts`, `templates.test.ts` (updated), new `preview.test.ts`

**Interfaces:**
- Produces:
  - `datasetRows(on, spaceId, configId, spec, from, to, pageSize?): AsyncGenerator<{ rows: DataRow[]; customer: Set<string> }>` — results via `reportResultRows` with `columnOf` of every ref the spec reads (columns, fallbacks, formula refs, filters, groups, header lines); items via `reportItemRows` (refs `recon:side`, `recon:status`, `item:<core|attrs.x>` mapped to the item's side as `a:`/`b:`); recap from results grouped by date + currency; v1 dedupe (`seen` item ids) kept for results; filters applied in memory (`status` filters pushed down as engine `statuses`).
  - `renderSections(spec, ctx: { name, recon, from, to, madeAt, final, count, sums: Record<string, number>, first: DataRow | null }): { title: string | null; header: { label: string; value: string }[] | null; footer: { text: string; stamp: string | null; pageNumbers: boolean } | null }` — tokens `{business_date}` `{from}` `{to}` `{recon}` `{made_at}` `{name}`.
  - `previewReport(ctx, templateId, versionId, body: { date: day }): { columns: { id, header }[]; rows: string[][]; problems: { columnId: string; message: string }[]; sections: ReturnType<typeof renderSections>; text: string | null; total: number }` — at most 50 rows of `date`, always masked, `text` = the Text rendering when `output.format === "txt"` (Task 4 writer on the 50 rows).
  - Route `POST /v1/spaces/:spaceId/reports/templates/:templateId/versions/:versionId/preview` guard `editReports` (draft) or `viewReports` (other statuses), body `ReportPreviewBody { date }`, no activity record: it changes nothing. If the conformance test requires every POST to record activity, add the route to that test's read-only allowlist with the reason "renders a preview, changes nothing" (as v1 did for the Test route if it is listed there).
  - `createTemplate` body `{ configId, name }` → version 1 with `emptySpec()`.
  - Save validates: `ReportSpec`, every formula compiles (problem path `columns.<i>.content.cel`), every ref is in the recon's catalog or flagged by `problems` (not rejected: Review Focus 5).
- Consumes: Tasks 1–2.

- [ ] **Step 1: Failing tests**
  - `rows.test.ts`: items dataset yields one row per item with `recon:side`; recap yields one row per date and currency with matched/breaks counts equal to v1 `dailySummary` on the same data; a filter `recon:status any_of [unmatch]` keeps only breaks; a v1 stored spec (inserted raw) reads the same rows as before (Review Focus 1).
  - `preview.test.ts`: preview of a spec with a formula column returns formatted cells and masked accounts even with `masking:"full"` + official; a column on `a:attrs.gone` returns empty cells and a problem "Field not in the data" (Review Focus 5); viewer without editReports on a draft → 403.
  - `templates.test.ts`: create with `{ configId, name }` → draft v1 spec equals `emptySpec()`; save with a broken formula → 400 with the formula's problem path.
  - `make.test.ts`: existing tests pass with v2 specs; one added: an after-run file of a v1-stored version has the v1 columns (Review Focus 1).
- [ ] **Step 2: Run** `bun test src/modules/reports` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** readers, sections, service/controller changes, preview.
- [ ] **Step 4: Run** `bun test src/modules/reports src/modules/engine/tests/integration/results.test.ts test/architecture` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(reports): dataset readers, sections, preview on spec v2`

### Task 4: Writers v2 (CSV, Text fixed-width, Excel, PDF)

**Files:**
- Modify: `write-csv.ts`, `write-xlsx.ts`, `write-pdf.ts`, `pdf-html.ts`, `pdf-data.ts`
- Create: `apps/api/src/modules/reports/write-txt.ts`
- Modify: `make.ts` (`write` dispatches on `output.format`, `txt` extension `.txt`; file name from `output.fileName` tokens)
- Modify: `packages/shared/src/reports.ts` (`REPORT_FORMATS` gains `txt`)
- Test: `apps/api/src/modules/reports/tests/unit/write.test.ts` (golden strings)

**Interfaces:**
- Produces: every writer takes `(pages: AsyncIterable<RenderedPage>, layout: RenderedLayout, out: string, o: { sections, groupLines, lineEnding, encoding }) → Promise<Written>` where `RenderedPage = { rows: { cells: string[]; raw: unknown[]; groupKey: string[] }[] }`, `RenderedLayout = { columns: { header: string; layout: Layout; numeric: boolean; total?: "sum"|"count" }[]; columnHeaders: boolean; groups: string[]; totals: TotalsSpec }`. Group and subtotal lines built in one shared helper (`grouped.ts` if needed) from `groupKey`.
- CSV: header record = header lines as `label,value` rows before the column header line; trailer record = footer text and totals line; v1 neutralization kept; `encoding: "ascii"` transliterates (NFKD, then drops what is still not ASCII); no BOM (as v1).
- Text: each line = `fitWidth` per column; header record / trailer record lines use the same widths (label column gets the first column's width, value the rest); `lineEnding` honoured.
- Excel: title row, header lines, column header row (bold via SheetJS cell styles unavailable → as v1, plain), data, totals, footer text; column widths from layout.
- PDF: HTML sections as the spec (title, header grid, table with column headers optional, group lines, totals, footer stamp + page numbers via Chromium footer template only when `pageNumbers`); JavaScript stays disabled.

- [ ] **Step 1: Failing golden tests** in `write.test.ts`, one spec fixture of 3 rows (a negative amount, a masked account, a long reference): CSV full sections; CSV data only (no header line); Text with widths `[4,10,12]`, zero pad, trailer `TOTAL 3`; Excel data only (sheet range starts at A1 with data, read back with SheetJS); PDF HTML (from `pdf-html`) data only has no `<h1>` and no `<thead>` when column headers off (Review Focus 3, 4).
- [ ] **Step 2: Run** `bun test src/modules/reports/tests/unit/write.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the writers and `make.ts` dispatch.
- [ ] **Step 4: Run** `bun test src/modules/reports` — Expected: PASS (make/files tests included; PDF test needs Chromium: run the PDF test in the API image as v1 did, or skip-guard as v1 does).
- [ ] **Step 5: Commit** `feat(reports): writers for spec v2 and Text fixed-width`

### Task 5: Field catalog endpoint

**Files:**
- Modify: `apps/api/src/modules/reports/service.ts`, `controller.ts`
- Modify: `packages/shared/src/contracts/reports.ts` (`ReportFieldDto`)
- Test: `apps/api/src/modules/reports/tests/integration/templates.test.ts`

**Interfaces:**
- Produces: `GET /v1/spaces/:spaceId/reports/templates/:templateId/fields?dataset=results|items|recap` (guard `viewReports`, not a list: add to conformance `NON_LIST_GETS` "the field catalog of one template") → `{ groups: { label: string; fields: { ref: string; label: string; type: "text"|"number"|"date"|"status"; customer: boolean }[] }[] }`: results → "Result" (recon fields: status, reason, rule/pass, assignee, days open, business date, info fields), "<side A label> · <source name>" (core fields then attributes of the source's active version), same for B; items → "Item" (side, status, business date) + the two sides' records; recap → date, currency, results, matched, breaks, match_rate, count_a, amount_a, count_b, amount_b. `customer` per the Global Constraints rule.
- Consumes: sources' active version spec (through the sources module index), recon result columns.

- [ ] **Step 1: Failing test**: catalog of the test recon lists `a:account_ref` with `customer: true`, `a:attrs.<fixture attr>` as text, recap group has `match_rate` as number.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `bun test src/modules/reports test/architecture` — PASS.
- [ ] **Step 5: Commit** `feat(reports): field catalog per dataset`

### Task 6: Customer flag on source attributes

**Files:**
- Modify: `packages/shared/src/contracts/sources.ts` (mapping gains `customer: string[]` of attr names, default `[]`, each must be a mapping attr key)
- Modify: `apps/api/src/modules/engine/results.ts` `reportResultRows` + `reportItemRows` customer set (`a:attrs.<name>` for the side's source flags)
- Modify: the source mapper UI where attributes are listed (`apps/web/src/features/sources/…` the attributes editor): a "Customer data" checkbox per attribute, same wording as the recon result columns editor
- Test: shared contract test; engine results integration test; web unit test of the mapper row

**Interfaces:**
- Produces: `SourceSpec.mapping.customer: string[]`; changing it makes a new source version (existing maker-checker, no new approval code).
- [ ] Steps 1–5 as TDD: contract rejects a customer name that is not an attr; reportResultRows masks `a:attrs.<flagged>`; the checkbox toggles the spec. Commit `feat(sources): mark an attribute as customer data`.

### Task 7: DS components

**Files (packages/ui/src/ds, exported from `index.ts`, each with a test and a gallery entry as existing components do):**
- Create: `field-list.tsx` — `FieldList({ groups, query, onQuery, onAdd, dragId? })`: grouped, searchable list; each field row has a type badge (`Abc`, `123`, `Day`, `●`, `ƒx`), a `masked` tag when `customer`, a + button (aria-label "Add <label> as a column"), draggable via a passed `useDraggable` render prop (dnd-kit stays in the feature; the DS row takes `dragHandleProps`).
- Create: `drop-zone.tsx` — `DropZone({ active, label, children })` dashed zone, active state colours from `--edit-*`.
- Create: `toggle-chips.tsx` — `ToggleChips({ label, items: { key, label, on }[], onToggle, extra? })` (aria-pressed buttons).
- Create: `format-example.tsx` — `FormatExample({ items: string[] })` "Looks like **…** and **…**".
- Create: `inspector.tsx` — `Inspector({ title, meta, children })` + `InspectorSection({ title, children })`.
- Reuse: `Switch` (form-options), `Segmented`, `Field`, `Combobox`, `Panel`, `BlockedButton`, `Notice`.
- Test: one `*.test.ts` per component with `renderToStaticMarkup` (labels, aria-pressed, masked tag).
- [ ] TDD steps; `cd packages/ui && bunx vitest run src/ds/<files>`; commit `feat(ui): designer building blocks (field list, drop zone, toggle chips, inspector, format example)`.

### Task 8: Web designer

**Files (apps/web/src/features/reports):**
- Rewrite: `spec-model.ts` — pure ops on `ReportSpec`: `addColumn(spec, content, at?)`, `moveColumn(spec, id, to)`, `replaceContent(spec, id, ref)`, `removeColumn`, `duplicateColumn`, `patchColumn(spec, id, patch)`, `addGroup`, `removeGroup`, `toggleSection(spec, key)`, `dataOnly(spec)`, `setFormat(spec, f)` (switching to txt sets missing widths from header length, min 4), `newColumnId(spec)`; `history` helpers `push/undo/redo` (max 80).
- Create: `designer-page.tsx` (three panes, top bar), `data-pane.tsx` (dataset select + `FieldList` + Build your own), `report-canvas.tsx` (sections chips, rows bar, group zone, table with dnd-kit sortable headers, drop indicators, Text ruler view, PDF page frame), `column-inspector.tsx`, `section-inspector.tsx`, `use-preview.ts` (POST preview, debounced 400 ms on spec change and date change, keeps last good result while loading), `use-fields.ts` (field catalog), `new-template-dialog.tsx` (Name + Recon, prefilled from the recon tab).
- Delete: `draft-wizard.tsx`, `new-template.tsx` start cards, `spec-rows.tsx`, v1 parts of `report-text.ts`, the `…/new` page route (the dialog replaces it) and `…/draft` route content → renders `designer-page`.
- Modify: `version-page.tsx` (read-only designer canvas for waiting/active versions, with the checker's decision), `template-page.tsx` (Edit draft → designer), `templates-page.tsx` (New report template opens the dialog), `generate-dialog.tsx` (format label incl. Text), `report-text.ts` (`FORMAT_LABEL.txt = "Text (fixed width)"`), routes and prefetch for `fields`/`preview`, nav unchanged.
- Test: `spec-model.test.ts` (every op; undo/redo; dataOnly; setFormat txt widths), `designer.test.tsx` via `renderToStaticMarkup` for the click paths: field + adds a column, section chip toggles `aria-pressed`, a column with a missing field shows "Field not in the data" (Review Focus 5), Delete key handler removes the selected column (pure handler `keyAction(e, state)` tested).
- Behaviour copied from the mockup (https://claude.ai/artifact/TviArtpASL6hgW5oaL8CiQ): drop between columns inserts, on a column's middle third replaces, on Group by groups; header drag reorders; + at table end opens a Combobox of fields; Alt+←/→ moves; Ctrl/⌘+Z, Shift+Z; toasts with Undo; autosave with `serialSaver` and "Saving…/Saved"; preview date picker; masked tag; Text view shows ruler + lines from the preview's `text`.
- [ ] TDD steps per file; `cd apps/web && bunx vitest run src/features/reports && bunx tsc --noEmit -p . && bunx eslint --max-warnings 0 src/features/reports`; commit `feat(reports): report designer`.

### Task 9: Docs, e2e, full check

**Files:**
- `docs/decisions` new DEC-061 (designer replaces the wizard; spec v2; v1 converted on read; sources joined; preview = file), `docs/api/README.md` rows (fields, preview, create body), `AGENTS.md` reports lines, copy-guide entries.
- Browser e2e (impacted only, owner rule): create a template from the dialog, add two fields by +, toggle Data only, switch to Text, Test → sample file appears.
- [ ] Run `PATH=/root/.local/bun-1.4.3:$PATH bun run check` — Expected: exit 0. Commit `docs(reports): report designer decisions and API rows`.
