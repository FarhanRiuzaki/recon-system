# Source mapper: file columns to the core record in a full-screen ERD (design)

Status: approved by owner 25 Nov 2026 ("go" on the short design). Project 2 of 2 after the file reader
(`2026-11-25-file-reader-design.md`).

## Intent and why

Setting up a file source should be near automatic (owner). The file reader now reads any file and names its columns;
step 2 of the source wizard (Fields and mapping) still shows those columns as a long table with selects for the core
fields. The owner wants the mapping in the style of the recon posting mapper ("kiri data, kanan kolom, tinggal tarik
garis"): the file's columns on the left with sample values, the core record on the right, lines for what maps where,
drawn from the existing suggestions so the user only corrects them, and a live preview underneath.

## Goals

- A full-screen mapper (`FullScreenEditor`) opened from step 2 with **Open mapper**:
  - Left: one table "File columns": each column with its type and the first sample value (from the preview).
    Computed columns (`derive`) are a second table "Computed".
  - Right: one table "Core record": `business_date`, `amount_minor`, `currency`, `direction`, `event_time`, `ext_ref`,
    `account_ref`, then a folded "Extra attributes (n)" row (settled #5).
  - A line per mapping that reads a column (`{ field }`). A core row mapped by a formula (`{ cel }`, e.g.
    `business_date ← file_date`) shows the formula in the row, no line.
  - Drag from a column's end to a core row's end to map it (replacing what was there); select a line or a row and press
    Delete (or the inspector's Remove) to unmap; tables move by drag; Reset layout.
  - The inspector (right rail) for the selected core row: where its value comes from (a column, or a formula), and for
    the amount its unit (major/minor). For a selected column: its type, nullable, trim, format (the same controls the
    step 2 table has), whether it is kept as an attribute and under which name.
  - The dock (under the canvas): the live preview (records and quarantined lines), as step 2 shows it today.
  - Header: title (the source's name), View as list, Cancel, Done. Done keeps the edits in the wizard draft; Cancel
    drops them (Escape asks when something changed), as the posting editor does.
- Step 2 starts with a summary ("5 core fields mapped · 3 extra attributes · 1 computed") and Open mapper; View as list
  shows today's tables (unchanged).
- The suggestions (`core-suggest`) run as today when columns arrive, so the first open already has its lines.
- Keyboard and touch never need to drag: every mapping can be made in the inspector or the list.
- Phone (< 768 px): the mapper opens as the list (the canvas needs room), like the posting editor.

## Non-goals

- New mapping kinds (fixed values, templates, lookups): the source spec has `{ field }` and `{ cel }` only.
- Changing the spec contract or the API: the mapper edits the same draft spec the table edits.
- Conditions (`keep`) and key fields: they stay in step 2 below the summary, as today.

## Anti-goals

- Two models that can disagree: the canvas and the list edit one draft (the wizard's `d.spec`).
- A recon-only canvas copied into sources: the canvas becomes one shared component both mappers use.
- A line that hides a rule the save would refuse: the inspector shows the same field errors the table shows (types
  that don't fit a core field, a missing `business_date`).

## Constraints

- AGENTS.md: a feature never imports a sibling feature, so `FieldMapCanvas` moves to `apps/web/src/components/field-map/`
  with a generic graph type; recon's action screen keeps its behaviour on the shared canvas (its tests and E2E prove it).
- The canvas and the editor load on demand (`next/dynamic`, `ssr: false`): the wizard's first load stays within the
  300 kB budget (DEC-040).
- Copy rules (§10), five data-region states, focus return when the editor closes, reduced motion as the posting editor.

## Approaches (owner picked A)

- **A. Reuse the posting mapper's canvas, made generic, inside a FullScreenEditor (picked).** One canvas for both
  mappers; the same interaction the owner already knows. Cost: moving and generalising the canvas, and re-testing the
  posting editor.
- B. A new, simpler two-column mapper only for sources. Less risk to the posting editor, but two mapping UIs that look
  and behave differently.
- C. Keep the step 2 table and draw lines beside it. No full screen; cramped with 14+ columns.

## Design

### Shared canvas (`apps/web/src/components/field-map/`)

- `FieldMapCanvas` and its `layout` move here. The graph type becomes generic:
  `{ sources: { id: string; title; caption; rows: { key; label; hint?: string; state? }[] }[]; target: { title; caption;
  rows: { path; label; note?: string; required?: boolean; locked?: boolean }[] }; edges: { id; source; row; target;
  label }[] }`. Recon's `mapGraph` returns this shape (its `SourceId` values as strings).
- Props stay: `graph`, `title`, `caption`, `selected`, `onSelect`, `onConnect(sourceId, row, target)`, `onRemove(target)`,
  `examples` becomes `hint` per row (the source side shows a sample value).

### Source graph (`apps/web/src/features/sources/mapper-model.ts`, pure)

- `sourceGraph(spec, preview): Graph`: the columns table (rows = `spec.fields`, hint = first preview example), the computed
  table (rows = `derive` names, hint = the formula), the core table (core paths, then `attrs.*`), edges for every
  `{ field }` mapping.
- `connect(spec, column, target): spec`: `target` = a core path or `attrs.<name>`; sets `{ field: column }` (amount keeps
  its unit); dropping a column on the "New attribute" row adds `attrs.<attrNameOf(column)>`.
- `disconnect(spec, target): spec`: a core field loses its mapping (`business_date` refuses: it is required, the
  inspector says so); an attribute row is removed.
- Pure and unit-tested; the wizard applies the result with `set()`.

### Screen (`apps/web/src/features/sources/steps/mapper.tsx`)

- `FullScreenEditor` with: rail = the selected item's inspector; canvas = `FieldMapCanvas`; dock = the preview panel the
  step already renders (shared component, not a copy).
- Edits go to a local copy of the draft; Done hands it to the wizard (`set(() => next)`), Cancel discards.

## Settled after the builder check (my calls)

1. **The dock previews the mapper's own draft.** The wizard's preview logic (debounced POST with the sample id or the
   pasted sample, business date) moves into a hook `useSpecPreview(spec)`; step 2 and the mapper's dock both call it,
   each with its own spec. Done hands the local draft to the wizard; Cancel drops it.
2. **Step 2 by default:** the summary, Open mapper, then keys and conditions as today. The columns, computed and recon
   fields tables sit under a closed "View as list" disclosure; Next opens it (and focuses the failing control) when an
   error points into those tables, so error routing keeps working. On a phone the disclosure starts open and Open
   mapper isn't offered.
3. **No "View as list" in the mapper's header** (the posting editor has none): the list is step 2's tables; Cancel / Done
   close the editor.
4. **What the inspector creates** for a core row: a column (also by drag), the file name's date or the arrival date
   for `business_date` (the presets step 2 offers today), a JSON path into a column (as "Use as" offers today), a free
   formula (CEL), and for `currency` "One currency for every row" (`spec.currency`). A JSON path draws a dashed line to
   its column with the path as the line's label; any other formula shows its text in the row, no line.
5. **Attributes don't flood the canvas.** Core rows have lines; attributes are one folded row "Extra attributes (14)"
   on the core side, with no lines. A column kept as an attribute shows an "attr" mark; the inspector toggles it and
   sets its stored name. Unfolding lists the attributes (no lines). The columns table gets a search box when it has
   more than 30 rows. The inspector sits in `FullScreenEditor`'s `inspector` slot, the column list in `rail`.

## Left to the builder

- Exact inspector layout, copy and icons within the design system.
- How the preview's examples reach the graph (the step already holds the preview result).
- Tests: unit for `sourceGraph`, `connect`, `disconnect` (column to core, column to new attribute, replace a mapping,
  remove an attribute, `business_date` refused); the recon action screen's existing unit tests and its E2E still pass on
  the shared canvas; a happy-dom test that Open mapper opens, a drag-free mapping through the inspector updates the
  summary, and Cancel leaves the draft unchanged; E2E only for what changed (owner rule).
