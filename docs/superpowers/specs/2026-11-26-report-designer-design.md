# Report designer (report generator v2) — design

Date: 26 Nov 2026 · Owner: recon-system owner · Replaces the template editor of `2026-11-25-report-generator-design.md` (DEC-060). Mockup the owner approved: https://claude.ai/artifact/TviArtpASL6hgW5oaL8CiQ (version 2).

## Intent

v1 shipped 25 Nov. The owner rejected its template editor: four "Start from" cards, a 5-step wizard, three fixed report kinds, columns picked from a list. What they want is a **report designer**: a person builds an external report from scratch and decides everything, down to the detail: which data, which columns in which order (drag and drop), each header, what each cell holds, every format, and which parts of the file exist at all. It must be **enterprise grade** (MEGA-SDD rule), **easy to use**, and built **in our design system** (new DS components where one is missing). Where a library already does an engine's job, use it; the designer itself is ours.

Owner's words, kept as requirements:
- "sebebas user": no preset kinds, no Start from cards.
- drag and drop columns, headers, "isi apa saja", "in detail micro".
- data from **a recon**, joined to its sources when the report needs record detail.
- **every section optional**: a file may be data only, with no header of any kind.
- user friendly, world-class UI.

## Goals

1. One designer page: Data (left) · the report as it will look, with real rows (centre) · settings of the selected thing (right), as in the mockup.
2. Free layout: any number of columns, any order, any header text; each column's content is a field, a formula, fixed text or a row number; per-column formats.
3. Data from a recon (its results, its items, its daily recap), joined to its sources for detail: every field and attribute of the source records behind each row (owner, 26 Nov: "dari data recon baru di join ke source … data source itu kalau mau detail report-nya"). A report on a source alone is not offered.
4. Sections (title, header block, column headers, totals, footer) each on/off; "Data only" turns all off.
5. Outputs: CSV, Excel, Text fixed-width, PDF, all from the same design.
6. Everything v1 does around the template stays: background making, the Files list, download logging, full-vs-masked download rights, maker-checker approval, after-run files, retention, Test samples.

## Non-goals

- Free pixel positioning on a page (a form-style PDF). The PDF is band layout. A later layer can add it.
- Joining several recons or sources in one report.
- Charts in reports.
- Scheduling at times other than "after each run" and "on request" (v1 behaviour).

## Anti-goals (a failure even if it works)

- The designer showing or exporting customer data that the masking rule would hide (a preview is always masked).
- A preview that differs from the file. The server renders both with one code path.
- Loss of v1's approval and audit guarantees.
- A designer only its author can use: every drag has a click and keyboard alternative, and every setting shows its effect immediately.

## Approaches considered

- **A. Embed a commercial designer** (Stimulsoft Reports.JS, ActiveReportsJS, Bold Reports). Full features at once, but a licence, a look outside our DS, and our data handed to it as JSON: masking and access then depend on our feed being right, and maker-checker and audit sit outside it.
- **B. Our own designer in the DS, engines from libraries** (chosen). Fits the DS and the mapper users already know, and masking, RLS, approval and audit stay native. Costs the most build.
- **C. Templates authored in Excel/Word with placeholders** (Carbone, Oracle ARCS style). Very free, but no drag and drop in the app and weak preview and validation; against the owner's picture.

Owner: "jika ada lib bisa dipakai secara engine-nya pakai aja … yang penting pakai DS kita". So B, with:

| Job | Engine |
|---|---|
| Drag and drop | `@dnd-kit/core` + `@dnd-kit/sortable` (already in apps/web) |
| Formulas | CEL (`@marcbachmann/cel-js`, the ingest environment with its allowlist and LIMITS) + the no-code steps of `packages/shared/src/compute.ts` |
| Excel | SheetJS (already used) |
| PDF | Chromium via `playwright-core` (already used) |
| CSV / Text fixed-width | our writers (small; the CSV rules of v1 kept) |

## The design

### Template, data and ownership

- A template belongs to **one recon** (as v1: `config_id`). Approval, after-run files and Final are v1's, unchanged.
- Its **data** ("From" in the mockup) is one of the recon's datasets: **Results** (one row per result: what v1 reads, `reportResultRows`), **Items** (one row per item, either side), **Daily recap** (one row per business date and currency; this is how v1's daily summary lives on).
- **Joined to the sources for detail**: a Results or Items row reaches the source records behind it (side A's and side B's), so the field catalog holds, per side, every core field of the record (reference, account, amount, currency, direction, event time, business date) and every attribute of that source's active version (its mapping's `attrs` keys), plus the recon's own fields (status, reason, rule, assignee, days open, info fields). A result that is a group of several items on one side shows a side field as the values joined with ", " when they differ (amounts: the sum); Items has one record per row, so it is the dataset for item-level detail. A field has a type: text, number, date or status.
- Customer data: an account is always customer data (v1 C1). A result column flagged Customer data on the recon (v1) and, new, a source attribute flagged Customer data in the source mapping are customer data. Masked unless the approved version says `full`; the preview is always masked.

### Spec v2 (shared contract; `ReportSpec` replaced)

```
dataset   { kind: results | items | recap }
rows      { filters: [{ field, op, value }], sort: [{ field, dir }] }    // ops by type, as the Results page filters
columns   [{ id, header, content, format, layout, highlight? }]
            content: { field, fallback? } | { formula: <CEL> } | { text } | { rownum }
            format : number { decimals, thousands ".", "," or none, negative minus | paren | trailing, prefix, suffix }
                     date { pattern from a fixed list: dd/MM/yyyy, yyyy-MM-dd, yyyyMMdd, ddMMyyyy, dd MMM yyyy, … }
                     text { case: as is | upper | lower }
            layout : { align l|c|r, width, pad " " | "0" }                // width = characters for Text, relative for others
            highlight: { when: not zero | negative | empty | equals <value>, style: red | bold }
groups    [field…] (nested), totals { rows: bool, per group: bool, which columns: sum | count }
sections  { title: { on, text with {tokens} }, header: { on, lines: [{ label, value: text | field of first row | count | sum }] },
            columnHeaders: on, footer: { on, stamp, pageNumbers, text } }
output    { format csv | xlsx | txt | pdf, csv: { delimiter , ; | tab, quote }, lineEnding CRLF | LF, encoding UTF-8 | ASCII,
            fileName pattern with {tokens}, masking masked | full }
official, when { afterRun, onRequest }                                // v1, unchanged
```

Every section is optional. "Data only" = all sections off and totals off.

For CSV and Text, the header block and footer are **lines of the file**: a header record and a trailer record. Each has its own columns (label, field, count, sum) with the same format and width settings. Regulator files commonly need these (count and total in a trailer). Excel and PDF show them as blocks above and below the table. *(My call, from regulator file conventions; the owner can drop it.)*

### Designer UX (as the mockup)

- **New report template**: a dialog with Name and Recon (prefilled when opened from a recon), then its dataset. Then straight into the designer with an empty table and the hint "Drag a field here". No cards.
- **Left, Data**: dataset picker, search, fields grouped (Result · side A's source record · side B's source record, each with its core fields then its attributes) with type badges and a "masked" tag on customer data. "Build your own": Formula, Fixed text, Row number.
- **Centre, Report**:
  - the section chips ("In the file: ✓ Title ✓ Header block ✓ Column headers ✓ Totals ✓ Footer · Data only");
  - the Rows bar (filters, sort, "N of M rows on the preview date");
  - the Group by zone, the table with real preview rows, the footer.
  - Drop between columns inserts, on a column replaces, on Group by groups. Column headers drag to reorder. + at the table's end opens a field picker.
  - The preview date picker reloads rows.
  - Text shows the file line by line with a character ruler; PDF shows a page.
- **Right, Settings**: of the selected column (header, content, format with a live example, highlight, layout, duplicate, remove), of a section (title text with tokens, header lines, footer options), or of the whole report (masking, totals).
- **Top**: name (inline edit), autosave state, undo and redo, the output switch, Test with real data (makes a sample file in Files, as v1), Send for approval.
- **Keyboard**: Ctrl/⌘+Z and Shift+Z, Delete removes the selected column, Alt+←/→ moves it, Enter on a field adds it. Every drag has a click equivalent.
- Mobile: the designer is a desktop task; below 760 px panes stack and drag falls back to the + buttons.

### Preview = file

`POST …/reports/templates/:id/versions/:vid/preview { date }` runs the same row reader, formatter and section renderer as the worker on at most 50 rows of one date, masked, and returns cells already formatted, plus a Text rendering for `txt`. The screen draws what it gets; formats are not re-implemented in the browser. The formula hint uses the same endpoint with a debounce.

### Migration from v1

- Each v1 template version is converted to spec v2 by a migration:
  - transactions → results dataset with the same columns;
  - grouped → groups and totals;
  - daily_summary → recap dataset with its columns.
- Statuses become a Status filter, output settings are kept.
- Files already made stay listed and downloadable.
- The wizard, the start cards and the v1 spec code are deleted (the unlabeled Results checkboxes go with them).

### Kept from v1 unchanged

Files list and detail, queue `reports.make` and its claims, download, full download and their logging, retention 400 days, janitor (stale files, missed after-run files), approval inbox, after-run auto files, limits (92-day range, PDF 5,000 rows, Excel 1,048,576 rows).

### DS work

New or extended DS components, built to `packages/ui` conventions with their own tests and a gallery entry:
- `FieldList` (grouped, searchable, draggable fields with type badge and tags);
- `DesignerTable` (sortable column headers, drop indicators, selected column);
- `DropZone` (Group by);
- `ToggleChips` (sections);
- `InspectorPanel` sections;
- `FormatExample` (a live example line);
- `FormulaInput` (CEL with field tokens and the result hint);
- `Switch`, if the DS has none.

Existing Panel, Segmented, Field, Select, Toast and BlockedButton are reused.

## Rules settled after the builder check (my calls unless marked)

- **Official and when stay** (v1): the template keeps `official` (an official version needs a checker's approval) and `when { afterRun, onRequest }`. `masking: full` is allowed only on an official template, as in v1.
- **Formulas and masking**: a formula reads real values, so it can compute (a difference, a check digit). If it names any customer-data field, its result is customer data and is masked like one. A preview is masked.
- **Source records joined**: the record each item points to (`recon_items.record_id`). The field catalog uses the active source version's attributes; a record from an older version without an attribute shows it empty.
- **Customer flag on a source attribute**: part of the source mapping, so it changes only through a source version and its approval (the sources maker-checker). Unflagging can't bypass review.
- **Items dataset**: one row per item, with a Side field (A or B) and side-neutral fields (reference, account, amount, dates, status, the item's attributes). Filter by Side to get one side.
- **Daily recap dataset**: one row per business date and currency. Results, matched, breaks, match rate, then count and amount per side.
- **Groups in CSV and Text**: by default a group only orders the rows. "Group and subtotal lines in the file" is an option, off by default, so a regulator file stays one record type unless the maker asks. Excel and PDF show group and subtotal lines.

## Left to the builder

- Exact endpoint names beyond preview.
- Converting v1 specs in SQL or in TypeScript.
- How undo is stored (client only is fine).
- The field picker of the + button.
- The exact filter ops per type (reuse the Results filters).
- Splitting into tasks.

## Testing

- Shared formatter: unit tests per format option.
- Each writer: golden files per format, including data only, header and trailer records, fixed-width padding, and negative styles.
- Preview equals the file: the same spec gives the same cells in preview and in the made file.
- CEL formulas: validation errors, and limits on save.
- Migration: v1 spec → v2 → the same file bytes for CSV.
- Web: unit tests on the spec model; DS components in packages/ui; the designer's drag paths through their click equivalents.
- Browser e2e: only the impacted flows (owner rule).
