# File reader: any CSV, TXT, fixed-length or Excel file, detected from a sample (design)

Status: approved by owner 25 Nov 2026 ("oke go"); builder-check answers below are my calls. Project 1 of 2 (owner 25 Nov); project 2 is the full-screen ERD mapper (file columns →
core record), which builds on the columns this project reads.

## Intent and why

Banks and partner systems send files in many shapes: CSV and TXT with any delimiter and encoding, title rows above the
header, total rows at the bottom, no header at all, fixed-length lines (columns by character position), Excel
workbooks with several sheets, and files with several header blocks where each block's header applies to the
transactions under it. Today recon-system reads one shape only: delimited text with the delimiter, quote, encoding and
"first row is a header" set by hand (`format.kind = "delimited"`, `apps/api/src/modules/ingest/parse.ts`). The owner
wants setting up a file source to be near automatic: pick the folder, the app reads a sample file, works out how to read
it, shows the table it got, and the user only corrects what it guessed wrong. When the app can't read a file
automatically it says so plainly ("not supported yet") and offers the manual setup.

## Goals

- One reader on the server for every supported shape, used by the wizard's preview and by the daily ingest alike:
  what the preview shows is what ingest loads.
- Detection from a sample: the app proposes the whole reading rule and the user confirms or corrects it.
- Shapes supported:
  1. Delimited text (`.csv`, `.txt`, `.dat`, any extension): delimiter `,` `;` `|` tab or another single character,
     quote, encoding (UTF-8 with or without BOM, UTF-16 by BOM, Windows-1252/Latin-1), title rows skipped at the top,
     the header row (or none), rows skipped at the bottom (totals, footers).
  2. Fixed-length text: columns by start position and length, same top/bottom skipping and header option.
  3. Excel: `.xlsx` and legacy `.xls`; the sheet (first sheet, by name, or by a name pattern like `ACT*`), the header
     row (or none), rows skipped at the top and bottom; Excel date serials and date cells become dates.
  4. Record types (on delimited and fixed-length text): lines told apart by a marker (the first N characters, or the
     value of one column), each type with its own columns and a role: header, detail, or skip (trailer, anything
     else). Each detail row is one output row and carries the columns of the last header row above it (owner: "the loop
     is per header").
- A sample comes from the folder the source reads (its newest file matching the pattern, read by the API from Inbox
  files) or from a file the user picks on their computer.
- Clear outcomes: a detected rule with a preview table; or "This file can't be read automatically yet" with what was
  found and the manual form; or "This file type isn't supported yet" (PDF, ZIP, XML, JSON, images) with no form.

## Non-goals

- Trailer control totals (row count, sum) are not checked (owner: not needed). A trailer is skipped.
- The ERD mapper (project 2). This project keeps step 2 (Fields and mapping) as it is; it receives the columns read.
- PDF, ZIP, XML and JSON files; Excel formulas are read as their cached values, never recalculated.
- Several detail types in one file mapped to different records (one detail type per source; others are skipped).

## Anti-goals

- A preview that differs from what ingest loads (two parsers).
- A guess applied silently: every detected setting is shown and editable before anything is saved.
- A file read whole into memory when it is text: text stays streamed line by line, as today.
- Breaking existing sources: a stored `delimited` spec without the new keys reads exactly as before.

## Constraints

- AGENTS.md: contracts in `packages/shared/src/contracts/sources.ts`, one module owning ingest parsing
  (`modules/ingest`), new routes in the endpoint table with their permissions, body limits (§3), exact-pinned
  dependencies (§5), UI copy rules (§10), five data-region states (§7).
- A new dependency for Excel is unavoidable (no few-lines way to read `.xlsx`/`.xls`); it is pinned exactly, used only
  in `modules/ingest`, server only (`apps/web` never imports it).
- Excel can't be streamed: a workbook is read whole. Excel files get their own size limit (`EXCEL_MAX_MB`, default 50).
- The detection request carries a sample, so its body limit is its own (like the inbox upload): at most 20 MB for a
  picked local file; a sample from Inbox files is read by the API from disk and needs no body.
- Spec changes are versioned like every source spec change today (maker-checker); `sameReading` rules keep applying.

## Approaches (owner picked A)

- **A. One reader on the server for preview and ingest, detection on the server (picked).** New format kinds in the
  spec; detection returns a proposed format plus a preview; the same parser runs in the pipeline. Cost: an Excel
  dependency and a larger parse module.
- B. Convert any odd file to a standard CSV on arrival and keep the pipeline as it is. Two copies per file, line
  numbers and quarantine reasons point at the converted file, duplicate detection hashes the copy.
- C. Detect in the browser, ingest on the server. Two parsers that can disagree; ruled out.

## Design

### Spec: `input.format` (contract)

A discriminated union; every kind has `encoding` (text kinds), `skip_top` (rows before the header or data, default 0)
and `skip_bottom` (rows at the end, default 0).

- `delimited`: today's keys (`delimiter`, `quote`, `header`, `encoding`) plus `skip_top`, `skip_bottom`, `records?`.
  `header: true` means the first row after `skip_top` is the header.
- `fixed_width`: `encoding`, `header` (one line to skip as a header after `skip_top`), `skip_top`, `skip_bottom`,
  `columns: [{ start, length }]` (1-based start; names come from `fields`, by order), `records?`.
- `excel`: `sheet: { kind: "first" } | { kind: "name", name } | { kind: "pattern", pattern }` (a glob on the sheet
  name; the first match), `header` (the row after `skip_top` is the header), `skip_top`, `skip_bottom`. No `records`.
- `records` (optional): `marker: { kind: "prefix", length } | { kind: "column", index }` and
  `types: [{ code, role: "header" | "detail" | "skip", columns? }]` (`columns` only for `fixed_width`: each type's own
  positions; for `delimited` each type's columns are its cells). Exactly one `detail` type; at most one `header` type.
  The output columns of a detail row are the header type's columns first (named `hdr_<n>` until the user names them in
  step 2), then the detail type's. A detail row before any header row gets empty header columns. A line whose marker is
  no listed type is quarantined ("Unknown record type <code>").

The spec's `fields` stay the output columns, by order, as today.

### Reader (`modules/ingest`)

- `readRows(source, format, columns, opts)`: one async iterator for every kind (today's `parseDelimited` becomes its
  delimited branch). Text kinds decode the stream (BOM sniffed first), split lines, drop `skip_top`, take the header,
  hold the last `skip_bottom` lines back and drop them at the end, apply `records`, yield the same `ParsedLine` shape
  as today (quarantine reasons per column, `fatal` for file-level faults, schema drift on header names).
- Excel: the workbook read whole (file size checked against `EXCEL_MAX_MB` first), the sheet picked, rows taken as
  cell values (dates as `yyyy-MM-dd` / ISO date-times, numbers as their plain text without grouping), then the same
  skip/header/drift handling.
- The pipeline (`ingestFile`) and the preview (`previewSample`) both call `readRows`.

### Detection (`modules/ingest/detect.ts`, pure where it can be)

Input: the sample's bytes (and its name). Output: `{ supported: true, format, columns: [names], confidence: "high" |
"low", notes: string[], preview }` or `{ supported: false, reason }`.

- Kind: Excel by signature (ZIP with `xl/workbook.xml` → xlsx; OLE `D0 CF 11 E0` → xls); PDF, ZIP without `xl/`,
  images, XML and JSON by signature or first bytes → not supported, with the type named; anything else is text.
- Encoding: BOM; else valid UTF-8; else Windows-1252.
- Delimited vs fixed-length: for each candidate delimiter (`,` `;` `|` tab), the share of lines whose cell count equals
  the most common count above 1; the best over 90 % wins. If none and most lines have the same length → fixed-length,
  with column boundaries proposed where a run of spaces lines up across lines or the character class changes (digits ↔
  letters) at the same position in most lines.
- Top and bottom: title rows are the leading lines whose cell count (or length) differs from the body's; footer rows
  the trailing ones that differ or start with a total word (`total`, `jumlah`, `grand`, `subtotal`, any case).
- Header: the first body row is a header when its cells are mostly non-numeric, distinct, and the rows below have
  numbers or dates where it has words.
- Record types: when the first cell (delimited) or the first 1–3 characters (fixed-length) take few distinct values
  (≤ 6) and the cell count or line length differs between them: the most frequent is detail, the one that comes right
  before runs of details is header, the one on the last line only is skip (trailer), any other is skip.
- Excel: each sheet's used range is scored like text rows; the sheet with the most body rows wins (its name is
  proposed as `name`); merged title cells count as title rows.
- Confidence is low when the winning delimiter share is under 98 %, the header call is close, or the record-type call is
  ambiguous; low confidence opens the settings for review instead of folding them.
- Detection never stores anything.

### API

- `POST /v1/spaces/:spaceId/sources/detect` (`source_admin` and `config_maker`, like the preview), body either
  `{ inbox: { path, pattern } }` (the newest complete file matching, read by the API inside `INBOX_ROOTS` and the space
  rule) or the raw bytes of a picked file (`x-file-name`, `Content-Length` ≤ 20 MB, streamed like the inbox upload).
  Answers the detection result with a preview of the first 50 rows (row roles marked: skipped, header, detail, trailer,
  quarantined).
- `POST …/sources/:sourceId/versions/:versionId/preview` keeps working for a pasted text sample and also takes
  `{ inbox: { path, pattern } }` so the preview reads the same file the detection read.

### Web: the File inbox step

- After a folder is picked (Inbox files list, done): the app runs detection on the folder's newest file at once.
- "How the file is read" panel replaces today's Delimiter / header switch / encoding fields:
  ```
  How the file is read                                   [Use another sample]
  act20261125.txt · Delimited · Pipe | · UTF-8 · No header · 2 rows skipped at the end   [Change]
  ┌──────────────────────────────────────────────────────────────┐
  │ #  col_01  col_02  col_03   …        role                     │
  │ 1  H       MERCH01 20261125           Header                  │
  │ 2  D       TRX001  100000             Detail                  │
  │ …                                                             │
  │ 48 T       47      4700000            Skipped (trailer)       │
  └──────────────────────────────────────────────────────────────┘
  ```
  Change opens the settings for the detected kind (kind segmented: Delimited / Fixed length / Excel; the kind's
  fields; record types as a small table: code, role). Fixed length shows the sample lines in mono with a character
  ruler: click between characters to add or remove a column boundary.
- Outcomes: detected (high) → folded summary; detected (low) → settings open with a notice "Check these settings: the
  file was hard to read."; can't detect → notice "This file can't be read automatically yet. Set how it is read below."
  with the manual settings open; not supported → notice "PDF files aren't supported yet. Ask the sender for CSV, TXT
  or Excel." and Next stays off.
- No folder files yet → "Use another sample" (pick a file on the computer) or set it manually.
- Step 2 receives the columns read (names from the header, or `col_NN`, with `hdr_NN` first for record types).

## Settled after the builder check (my calls)

1. **Samples the preview can reuse.** Detection answers a `sampleId`. An Inbox files sample is the file itself
   (`{ inbox: { path, name, size, modifiedAt } }`, read again from disk); a file picked on the computer is kept by the
   API at `<space root>/.samples/<uuid>` (a dot folder: never listed, never ingested) and swept by the inbox janitor
   after 24 hours. Step 2's preview sends `{ sampleId }` instead of the text, so Excel and the file's end work the same
   as in ingest. The paste panel stays only inside the manual settings ("Paste lines instead").
2. **Record types carry their column count.** Each type stores `count` (delimited: cells per line; fixed-length: its
   `columns`). The marker cell is an output column like any other. Output columns of a detail row: the header type's
   `count` columns (named `hdr_01`…), then the detail type's (`col_01`…). A line whose cell count isn't its type's
   count is quarantined ("Expected 5 columns for record type D, got 4").
3. **Who detects.** Detection and changing how the file is read stay a source admin's (`SPACE_ACTION.connectSource`
   guards the detect route), as `sameReading` already rules. A config maker or checker sees "How the file is read"
   folded and read-only, with the stored format and a preview of a sample (`sampleId` from the inbox file); they
   never trigger detection.
4. **Old specs keep their hash.** The new keys (`skip_top`, `skip_bottom`, `records`) are optional with no default
   written into the spec; absent means 0 / none in the reader. A stored `delimited` spec hashes and compares exactly
   as before.
5. **How much detection reads.** Text: the first 2,000 lines and the last 200 lines (two ranged reads, at most 4 MB in
   all); the preview shows the first 50 rows and the last rows that the rule skips. Excel: the whole workbook up to
   `EXCEL_MAX_MB`.

## Left to the builder

- The Excel library (pinned exact; must read `.xlsx` and `.xls`, cell types and dates; server only).
- Thresholds above are starting values; tune them against the sample files the owner drops in Inbox files.
- Copy within AGENTS.md §10; component choices within the design system.
- Tests: unit for detection on fixtures of each shape (including the owner's real samples once provided), for every
  format kind's reading and for record types; integration for the detect route (inbox sample, picked file, not
  supported, size limit) and for ingest of each kind end to end; existing delimited sources unchanged (regression).
