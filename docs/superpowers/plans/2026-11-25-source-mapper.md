# Source mapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-screen ERD mapper for a source's fields (file columns → core record), opened from step 2 of the
source wizard, on the canvas the recon posting mapper uses.

**Architecture:** The posting canvas moves from `features/recon` to `components/field-map` with a generic graph type;
recon keeps using it. A pure `features/sources/mapper-model.ts` turns a draft spec into that graph and applies
connect / disconnect / inspector edits; `steps/mapper.tsx` renders it in `FullScreenEditor` with an inspector and a
dock that previews the mapper's own draft through a shared `useSpecPreview` hook. Step 2 becomes a summary + Open
mapper, its tables under a "View as list" disclosure.

**Tech Stack:** Next.js 16, React 19, `@starterkit/ui/flow` (React Flow 13.0.2 wrappers), `@starterkit/ui/ds/full-screen-editor`, Vitest (happy-dom).

**Spec:** `docs/superpowers/specs/2026-11-25-source-mapper-design.md` (approved; "Settled after the builder check" is binding).

## Global Constraints

- No API or contract change: the mapper edits the wizard's draft spec (`d.spec`: `fields`, `mapping`, `derive`, `currency`).
- `features/sources` never imports `features/recon` (and back): the shared canvas lives in `apps/web/src/components/field-map/`.
- The mapper and canvas load through `next/dynamic` with `ssr: false` (DEC-040 budget).
- Core rows, in order: `business_date` (required), `amount_minor`, `currency`, `direction`, `event_time`, `ext_ref`, `account_ref`; then the folded row "Extra attributes (n)".
- Lines only for core rows mapped `{ field }` (solid) or a JSON path `{ cel: "<col>.<path>" }` on a column (dashed, labelled with the path); attributes never draw lines.
- `business_date` can't be removed: "The business date is required. Map it to a column or a date preset."
- Column search box when the columns table has more than 30 rows.
- Step 2: summary "N core fields mapped · M extra attributes · K computed" + Open mapper (hidden below 768 px); its tables under a closed "View as list" disclosure that opens when an error points inside it; open by default below 768 px.
- Copy English, sentence case (AGENTS.md §10).

## Review Focus

1. A column dragged onto a core row already mapped from another column: the old line goes, the new one shows, the old column stays an attribute if it was one. Test in Task 2.
2. A column renamed or removed in "How the file is read" after mapping: its mapping shows as broken (red row note), not a line to nowhere. Test in Task 2.
3. Cancel after edits: the wizard's draft is exactly as before (deep equal). Test in Task 4.
4. A 200-column file: the canvas renders (folded attributes, searchable columns) without one node per attribute. Test in Task 2 (graph size) and Task 4 (search).
5. The posting editor on the shared canvas: drag, delete, reset layout and examples behave as before. Existing tests in Task 1.

---

### Task 1: Shared canvas

**Files:** Create `apps/web/src/components/field-map/{canvas.tsx,graph.ts}`; delete `features/recon/field-map-canvas.tsx`; modify `features/recon/field-map.ts` (return type `MapGraph`), `features/recon/action-screen.tsx` (import path). Test: existing `features/recon/field-map.test.ts`, `action-screen` tests; new `components/field-map/graph.test.ts`.

**Interfaces — Produces (`graph.ts`):**
- `MapSourceTable = { id: string; title: string; caption: string | null; rows: { key: string; label: string; kind: string; broken?: string }[] }`
- `MapTargetRow = { path: string; name: string; depth: number; leaf: boolean; required: boolean; type: string; maxLength: number | null; filledBy: "fixed" | "auto" | null; mapped: string | null; note?: string; folded?: number }`
- `MapEdge = { id: string; source: string; row: string; target: string; label: string | null; dashed?: boolean }`
- `MapGraph = { sources: MapSourceTable[]; request: MapTargetRow[]; edges: MapEdge[]; missing: string[] }`
- `FieldMapCanvas` props unchanged plus `targetTitle?: string` (recon passes "Request").

- [ ] Step 1: failing test `graph.test.ts`: `edgeStyle({ dashed: true })` → `{ strokeDasharray: "4 4" }`, `edgeStyle({})` → `undefined` (a tiny helper the canvas uses for dashed edges).
- [ ] Step 2: `cd apps/web && bunx vitest run src/components/field-map/graph.test.ts` → FAIL.
- [ ] Step 3: move the canvas (git mv), type it with `MapGraph`, add `edgeStyle`, a row `note` under the row label (red when `broken` on a source row), `folded` rows render "Extra attributes (n)" with no handle.
- [ ] Step 4: `bunx vitest run src/components/field-map src/features/recon src/test` → PASS; typecheck.
- [ ] Step 5: commit `refactor(web): the field map canvas is shared (components/field-map)`.

### Task 2: Source graph model

**Files:** Create `apps/web/src/features/sources/mapper-model.ts`, test `mapper-model.test.ts`.

**Interfaces — Produces:**
- `CORE_ROWS = ["business_date", "amount_minor", "currency", "direction", "event_time", "ext_ref", "account_ref"] as const`
- `sourceGraph(spec: SourceSpec, examples: Record<string, string>, opts?: { q?: string }): MapGraph` — sources: "File columns" (rows = `spec.fields` filtered by `q`, `kind` = field type, `broken` never), "Computed" (rows = `derive` names, kind "formula"); request: core rows (note = the formula text for a `{ cel }` that isn't a JSON path, `mapped` = "field"|"cel"|null; a `{ field }` naming no field → note "Column <name> isn't in the file any more", mapped null) then one `folded` row with the attribute count; edges for `{ field }` (solid) and JSON paths `<col>.<path…>` where `<col>` is a field (dashed, label = path).
- `connect(spec: SourceSpec, column: string, target: CoreRow): SourceSpec` — `{ field: column }` (amount keeps `unit`); the column keeps its attribute.
- `disconnect(spec: SourceSpec, target: CoreRow): SourceSpec | { refused: string }` — business_date refused with the Global Constraints sentence.
- `setSource(spec, target, value: { field: string } | { cel: string } | { preset: "file_date" | "arrived_date" } | { currency: string }): SourceSpec` — presets write `{ cel: "file_date" }` / `{ cel: "arrived_date" }` (the cel names step 2 uses today); `{ currency }` sets `spec.currency` and removes `mapping.currency`.
- `toggleAttr(spec, column, on: boolean, name?: string): SourceSpec` and `summaryLine(spec): string` ("3 core fields mapped · 11 extra attributes · 1 computed").

- [ ] Step 1: failing tests: KSEI spec (sid→account_ref, sre attr, business_date file_date) → edges `[sid→account_ref]`, business_date row note "file_date", folded row count 14; connect `sre`→`account_ref` replaces the sid edge; disconnect `account_ref` → no edge; disconnect `business_date` → refused sentence; a JSON path `{ cel: "data.code.rc" }` on `ext_ref` with field `data` → dashed edge labelled "code.rc"; a mapping to a removed field → note "Column sid isn't in the file any more" and no edge; 200 fields → `sources[0].rows.length === 200`, `request.length === 8`; `q: "sid"` → only matching rows; `setSource(currency: "IDR")` → `spec.currency === "IDR"`, no `mapping.currency`; `summaryLine`.
- [ ] Step 2: `bunx vitest run src/features/sources/mapper-model.test.ts` → FAIL.
- [ ] Step 3: implement (pure; reuse `attrNameOf`, `withCore`-free).
- [ ] Step 4: PASS.
- [ ] Step 5: commit `feat(web): the source mapper's graph and edits`.

### Task 3: Shared preview hook

**Files:** Create `apps/web/src/features/sources/use-spec-preview.ts`; modify `wizard.tsx` (step 2 uses it). Test `use-spec-preview.test.ts` (happy-dom, mocked `api`).

**Interfaces — Produces:** `useSpecPreview(o: { spaceId: string; ids: { sourceId: string; versionId: string } | null; spec: SourceSpec; file: boolean; sampleId: string | null; sample: string; fileName: string; businessDate: string; enabled: boolean }): { result: SourcePreviewDto | null; error: string | null; pending: boolean; run: (fresh?: boolean) => void }` — debounced 400 ms after the last spec change, latest call wins (as `runPreview` today).

- [ ] Step 1: failing test: two spec changes within 400 ms send one POST with the second spec; a `sampleId` sends `{ sampleId, spec }`; a disabled hook sends nothing.
- [ ] Step 2: run → FAIL. Step 3: move `runPreview`'s body into the hook; the wizard keeps its own field-error and value-hint side effects through an `onResult` callback option. Step 4: `bunx vitest run src/features/sources` → PASS. Step 5: commit `refactor(web): the source preview as a hook any draft can use`.

### Task 4: Mapper screen and step 2 summary

**Files:** Create `apps/web/src/features/sources/steps/mapper.tsx`; modify `steps/fields.tsx` (summary + Open mapper + "View as list" disclosure), `wizard.tsx` (error routing opens the disclosure). Test `steps/mapper.test.ts` (happy-dom; the canvas mocked to a list of rows with buttons, since React Flow needs layout).

**Interfaces — Consumes:** Task 1 `FieldMapCanvas`, Task 2 model, Task 3 hook. **Produces:** `SourceMapper({ open, spec, examples, preview props, onDone(spec), onCancel })`.

- [ ] Step 1: failing tests:
  - Open mapper shows the title and the summary line; choosing `account_ref` then "Column: sre" in the inspector and pressing Done calls `onDone` with `mapping.account_ref = { field: "sre" }`.
  - Cancel after an edit calls `onCancel` and the spec passed in is deep-equal to before (no mutation).
  - Remove on `business_date` shows "The business date is required. Map it to a column or a date preset." and leaves it mapped.
  - 31 fields → a "Search columns" box; typing "sid" leaves one column row.
  - step 2 (`fields.tsx`): summary text present, "View as list" closed; a field error id inside the tables opens it.
- [ ] Step 2: `bunx vitest run src/features/sources/steps/mapper.test.ts` → FAIL.
- [ ] Step 3: implement (FullScreenEditor: `rail` = columns search + legend, canvas = `FieldMapCanvas` loaded with `next/dynamic`, `inspector` = the selected row's controls, dock = preview from `useSpecPreview` on the local draft; Escape with changes asks as the posting editor does).
- [ ] Step 4: `bunx vitest run --maxWorkers=2 src/features/sources src/features/recon src/components src/test` → PASS; typecheck; lint.
- [ ] Step 5: commit `feat(web): map a source's fields in a full-screen mapper`.

### Task 5: Docs, check, deploy

- [ ] Step 1: `docs/decisions.md` DEC-059 (source mapper; shared canvas), copy guide if new terms.
- [ ] Step 2: `bun run check` alone; the 17 known environment failures allowed, nothing new.
- [ ] Step 3: commit `docs: source mapper`.
- [ ] Step 4: deploy on tibsdev (ff main, chmod, build, migrate, up).
- [ ] Step 5: smoke on "Demo inbox": the `hdt` source draft → step 2 → Open mapper; map `account_ref`, Done; screenshots of the mapper and the posting editor (unchanged) to the owner.
