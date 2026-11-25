# File reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File sources read any delimited text, fixed-length text, Excel workbook or header/detail file, with the
reading rule detected from a sample and shown as a preview table the user can correct.

**Architecture:** One reader in `apps/api/src/modules/ingest` (`readRows`) used by the pipeline and the preview;
`detect.ts` proposes a `format` from a sample's bytes; samples live in Inbox files (the folder's file, or a picked file
kept under `<space root>/.samples/`); the wizard's File inbox step shows "How the file is read" and passes `sampleId`
to step 2's preview.

**Tech Stack:** Bun 1.4.3, Elysia, Drizzle/PostgreSQL, Next.js 16 BFF, zod contracts, `csv-parse` 7.0.3 (existing),
SheetJS `xlsx` 0.20.3 (new, from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, API only).

**Spec:** `docs/superpowers/specs/2026-11-25-file-reader-design.md` (approved 25 Nov 2026, with "Settled after the
builder check").

## Global Constraints

- New format keys `skip_top`, `skip_bottom`, `records` are optional with **no default written**; absent = 0 / none.
  A stored `delimited` spec parses, hashes (`specHash`) and reads exactly as before.
- Format kinds: `delimited` | `fixed_width` | `excel`. `records` only on `delimited` and `fixed_width`; exactly one
  `detail` type, at most one `header` type; every type has `count`.
- Output columns of a record-typed detail row: header type's `count` columns (`hdr_01`…) then the detail type's
  (`col_01`…); the marker cell is an output column.
- Detection reads text: first 2,000 lines + last 200 lines, at most 4 MB in all; Excel: whole workbook ≤
  `EXCEL_MAX_MB` (API env, default 50, 1–128).
- Picked sample: ≤ 20 MB, kept at `<space root>/.samples/<uuid>`, swept by `tendInbox` after 24 h.
- Detect route guard: `SPACE_ACTION.connectSource`. Preview keeps `SPACE_ACTION.previewSource`.
- Not supported (named in the message): PDF, ZIP (not xlsx), images, XML, JSON.
- Copy (English, AGENTS.md §10), verbatim: "This file can't be read automatically yet. Set how it is read below.",
  "Check these settings: the file was hard to read.", "<Type> files aren't supported yet. Ask the sender for CSV, TXT
  or Excel.", "Unknown record type <code>", "Expected <n> columns for record type <code>, got <m>".
- Text is streamed line by line in ingest; only Excel is read whole.
- `xlsx` is imported only in `modules/ingest` (architecture: `apps/web` never).

## Review Focus

1. An existing `delimited` source (spec without the new keys) ingests the same rows and keeps its `specHash`. Test in Task 1 and Task 2.
2. A quoted cell holding a line break near the end with `skip_bottom: 1`: the skip counts records, not raw lines. Test in Task 2.
3. Excel cells: a text cell `0012` stays `0012`, a date cell becomes `2026-11-25`, a number `1500000` stays `1500000` (no `1.5e6`, no grouping). Test in Task 3.
4. A Windows-1252 file with CRLF endings and `é`: read as `é`, no stray `\r` in the last cell. Test in Task 2.
5. A detail line before the first header line in a record-typed file: kept with empty `hdr_*` columns. Test in Task 2.

---

### Task 1: Contracts

**Files:** Modify `packages/shared/src/contracts/sources.ts`, `packages/shared/src/sources.ts`; regenerate `docs/api/schemas` (`bun run api:schemas`). Test: `packages/shared/src/contracts/sources-format.test.ts` (new).

**Interfaces — Produces:**
- `FileFormat` = zod discriminated union on `kind`:
  - `delimited`: existing keys + `skip_top?: int 0–1000`, `skip_bottom?: int 0–1000`, `records?: RecordTypes`
  - `fixed_width`: `encoding`, `header: boolean`, `skip_top?`, `skip_bottom?`, `columns: [{ start: int ≥1, length: int 1–10000 }] (1–500)`, `records?`
  - `excel`: `sheet: { kind: "first" } | { kind: "name", name: string 1–31 } | { kind: "pattern", pattern: string 1–64 }`, `header: boolean`, `skip_top?`, `skip_bottom?`
- `RecordTypes` = `{ marker: { kind: "prefix", length: 1–10 } | { kind: "column", index: 0–499 }, types: [{ code: string 1–20, role: "header"|"detail"|"skip", count: 1–500, columns?: [{ start, length }] }] (2–10) }` with refinements: exactly one detail, ≤1 header, `columns` present iff the format is `fixed_width`.
- `DetectBody` = `{ inbox: { path, pattern } }` (JSON); a picked file is a raw body (no schema).
- `DetectDto` = `{ supported: true, sampleId: string, fileName: string, format: FileFormat, columns: string[], confidence: "high"|"low", notes: string[], rows: { line: number, role: "skipped"|"header"|"detail"|"record_header"|"trailer"|"quarantined", cells: string[] }[] } | { supported: false, fileName: string, type: string, reason: string }`
- `PreviewSourceBody` gains a third variant `{ sampleId: string(uuid or "inbox:<path>|<name>|<size>|<mtime>" ≤ 2048), spec?: SourceSpec }`.
- `FILE_KINDS = ["delimited", "fixed_width", "excel"] as const` in `packages/shared/src/sources.ts`.

- [ ] Step 1: failing tests: an old delimited spec `{ kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" }` parses to an object with **no** `skip_top`/`skip_bottom`/`records` keys; fixed_width with two columns parses; excel `{ sheet: { kind: "pattern", pattern: "ACT*" }, header: true }` parses; records with two detail types → error; `columns` on a delimited record type → error; `PreviewSourceBody` accepts `{ sampleId }`.
- [ ] Step 2: `cd packages/shared && bunx vitest run src/contracts/sources-format.test.ts` → FAIL.
- [ ] Step 3: implement; keep `FileInboxInput.format` = `FileFormat`.
- [ ] Step 4: same → PASS; `bun run typecheck` → fix call sites that narrow `format.kind === "delimited"` (web `spec-draft.ts`, `connection.tsx`, API `parse.ts`, `preview.ts`) to compile, behaviour unchanged.
- [ ] Step 5: commit `feat(shared): file format kinds, record types, detect and sample contracts`.

### Task 2: Text reader (delimited, fixed-length, records)

**Files:** Create `apps/api/src/modules/ingest/read.ts`, `apps/api/src/modules/ingest/decode.ts`; modify `parse.ts` (delimited branch keeps its code, gains skip_top/skip_bottom), `service.ts` (pipeline calls `readRows`), `preview.ts`. Test: `apps/api/src/modules/ingest/tests/unit/read.test.ts`.

**Interfaces — Produces:**
- `decodeStream(bytes: AsyncIterable<Uint8Array>, encoding: FileEncoding): AsyncIterable<string>` (BOM stripped: UTF-8, UTF-16LE/BE override the declared encoding).
- `readRows(source: AsyncIterable<Uint8Array>, format: FileFormat, columns: string[], opts?: ParseOptions): AsyncGenerator<ParsedLine>` — text kinds stream; `excel` delegates to Task 3's `readWorkbook` (throws "not yet" until Task 3).
- `readText(text: string, format, columns): Promise<ParsedLine[]>` (the preview's; replaces `parseText` callers).
- `ParsedLine` unchanged.

- [ ] Step 1: failing tests:
  - old delimited spec over the KSEI fixture gives the same `ParsedLine[]` as `parseText` did (copy expected from the existing parse test).
  - `skip_top: 2, header: true` on `"Report\nDate x\nA|B\n1|2\n"` → one row `{A:"1",B:"2"}` with header names checked.
  - `skip_bottom: 1` with `'a|"x\ny"\nTOTAL|9\n'` → one row, cell `"x\ny"` (records counted, not lines).
  - fixed_width columns `[{start:1,length:3},{start:4,length:5}]` on `"ABC12345\nDEF  678\n"` → `["ABC","12345"]`, `["DEF","678"]` (trimmed by the field's own `trim`, raw kept untrimmed).
  - records delimited: marker column 0, types H(count 3, header) D(count 3, detail) T(count 2, skip); `"D|X|1\nH|M1|20261125\nD|T1|100\nD|T2|200\nT|2\n"` → rows `[hdr_01..03 empty, D,X,1]`, `[H,M1,20261125,D,T1,100]`, `[H,M1,20261125,D,T2,200]`; a `Q|…` line → quarantined "Unknown record type Q"; `D|T3` → "Expected 3 columns for record type D, got 2".
  - records fixed_width with marker prefix 1.
  - windows-1252 bytes `0x63 0x61 0x66 0xE9 0x7C 0x31 0x0D 0x0A` → cells `["café","1"]`.
- [ ] Step 2: `cd apps/api && bun test src/modules/ingest/tests/unit/read.test.ts` → FAIL.
- [ ] Step 3: implement. skip_bottom: hold the last N parsed records in a ring buffer and emit only once N newer ones exist. Record types run after splitting a line into cells (delimited) or before slicing (fixed_width: marker from the raw line, then that type's columns).
- [ ] Step 4: PASS; `bun test src/modules/ingest` → all green (pipeline + preview now on `readRows`).
- [ ] Step 5: commit `feat(ingest): one reader for delimited and fixed-length text with skips and record types`.

### Task 3: Excel reader

**Files:** `apps/api/package.json` (`"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`, `bun install` through the proxy), `bun.lock`; create `apps/api/src/modules/ingest/excel.ts`; `kernel/config.ts` (`EXCEL_MAX_MB: int(1, 128, 50)` in API and worker fields); `.env.example`s; compose allow-lists. Test: `tests/unit/excel.test.ts` with fixtures built in the test by `xlsx.utils` (no binary fixtures committed).

**Interfaces — Produces:** `readWorkbook(bytes: Uint8Array, format: ExcelFormat, columns: string[]): ParsedLine[]`; `sheetNames(bytes): string[]`; `cellText(cell): string` (date → `yyyy-MM-dd` or ISO date-time when it has a time; number → plain decimal text; text as is).

- [ ] Step 1: failing tests: two sheets `Summary`, `ACT 25-11`; `{ sheet: pattern "ACT*", header: true, skip_top: 1 }` reads `ACT 25-11` rows after a title row; text `0012` stays, date `2026-11-25`, number `1500000`, `0.1+0.2`-style float `0.3` written as `0.3`; `{ kind: "name", name: "Nope" }` → fatal "file" with reason "No sheet named Nope (sheets: Summary, ACT 25-11)."; `.xls` (BIFF8 written by `xlsx.write({bookType:"biff8"})`) reads the same; a workbook over `EXCEL_MAX_MB` → fatal "file" "The workbook is over N MB.".
- [ ] Step 2: `bun test src/modules/ingest/tests/unit/excel.test.ts` → FAIL.
- [ ] Step 3: implement; `readRows` for `excel` reads the source fully (size checked as it accumulates) then yields `readWorkbook`'s lines.
- [ ] Step 4: PASS; `bun test test/architecture` → PASS (add `xlsx` to any dependency allowlist the boundaries test keeps).
- [ ] Step 5: commit `feat(ingest): read Excel workbooks (xlsx, xls) with sheet choice`.

### Task 4: Detection

**Files:** Create `apps/api/src/modules/ingest/detect.ts`. Test: `tests/unit/detect.test.ts` with text fixtures in `tests/unit/fixtures/files/*.txt|csv` (small, synthetic) and workbooks built in the test.

**Interfaces — Produces:** `detect(sample: { head: Uint8Array; tail: Uint8Array | null; size: number; name: string }): DetectOutcome` where `DetectOutcome` = DetectDto without `sampleId` (the route adds it).

- [ ] Step 1: failing tests (one per shape, asserting `format` and `confidence`):
  - KSEI ACT pipe, no header → delimited `|`, header false, high.
  - `;` CSV with header and BOM → delimited `;`, header true, encoding utf-8.
  - 3 title lines + header + rows + `Total,…` → skip_top 3, header true, skip_bottom 1.
  - fixed-length bank lines → fixed_width, boundaries at the aligned space runs.
  - H/D/T pipe file → records marker column 0, H header, D detail, T skip, counts right.
  - two-sheet workbook → excel, sheet name of the larger sheet.
  - `%PDF-` → `{ supported: false, type: "PDF" }`; random binary → `{ supported: false, type: "binary" }`.
  - ragged text with no consistent delimiter or length → supported true, confidence low, notes non-empty.
- [ ] Step 2: run → FAIL. Step 3: implement (algorithm and thresholds in the spec's Detection section). Step 4: PASS. Step 5: commit `feat(ingest): detect how a file is read from a sample`.

### Task 5: Samples, detect route, preview by sample, ingest of every kind

**Files:** `apps/api/src/modules/inbox/{disk.ts,service.ts,index.ts}` (samples: `saveSample`, `readSample`, sweep `.samples` in `tendInbox`), `apps/api/src/modules/sources/{controller.ts,service.ts}` (`POST /v1/spaces/:spaceId/sources/detect`, preview accepts `sampleId`), `packages/shared/src/body-limit.ts` (`isSourceDetect(path)` streamed like the upload; web proxy matcher excludes it), `apps/web/src/proxy.ts`, `apps/web/src/lib/server/forward.ts`, docs table. Tests: `sources/tests/integration/detect.test.ts`, `ingest/tests/integration/pipeline.test.ts` (one case per new kind).

**Interfaces — Produces:**
- `POST /v1/spaces/:spaceId/sources/detect` → `DetectDto`. JSON `{ inbox: { path, pattern } }`: newest complete file matching, inside the space rule (`ownFolder`), head 2,000 lines/tail 200 lines (Excel whole). Raw body (`x-file-name`, `Content-Length` ≤ 20 MB): saved by `saveSample(spaceCode, bytes) → uuid`, then detected.
- `sampleId`: a uuid (picked) or `inbox:` + JSON of `{ path, name, size, modifiedAt }` (the same file; 409 `invalid_state` "The sample file changed. Detect again." when its size or time moved).
- Preview with `{ sampleId, spec? }` reads the sample through `readRows` (first 100 records and the quarantined lines, as today's preview list).

- [ ] Step 1: failing tests: detect from an inbox folder of a KSEI file → delimited pipe, `sampleId` starting `inbox:`; picked `.xlsx` (raw body) → excel, `sampleId` uuid, file under `.samples/`; PDF → `supported: false`; 21 MB → 413 `too_large`; config_maker → 403; preview with that `sampleId` + spec → rows; a sample older than 24 h is swept by `tendInbox`; pipeline ingests a fixed_width file, an excel file and an H/D/T file into records (one assertion each on `records` count and one header-carried attr).
- [ ] Step 2: run the two files → FAIL. Step 3: implement. Step 4: PASS + `bun test test/architecture` + `cd apps/web && bunx vitest run src/lib/server src/proxy.test.ts`. Step 5: commit `feat(sources): detect a file's reading from Inbox files or a picked file; preview and ingest every kind`.

### Task 6: Web — "How the file is read"

**Files:** Create `apps/web/src/features/sources/steps/file-read.tsx` (panel), `steps/file-read-model.ts` (pure: summary text, row role labels, fixed-width boundaries toggle, records table edits), `steps/fixed-ruler.tsx`; modify `steps/connection.tsx` (Folder: on pick → detect; replaces Delimiter/header/encoding fields), `wizard.tsx` (keeps `sampleId`; step 2 preview sends `{ sampleId, spec }`; step 2's paste panel only behind "Paste lines instead"), `spec-draft.ts` (columns from `DetectDto.columns`), `use-sources.ts` (`detectSample` call). Tests: `steps/file-read-model.test.ts`, `steps/file-read.test.ts` (happy-dom).

**Interfaces — Consumes:** `DetectDto` (Task 1), `POST …/sources/detect` (Task 5).

- [ ] Step 1: failing tests:
  - `summaryOf(format, fileName)` → `"act20261125.txt · Delimited · Pipe | · UTF-8 · No header · 1 row skipped at the end"`; excel → `"report.xlsx · Excel · Sheet ACT 25-11 · Header on row 2"`.
  - `toggleBoundary([{start:1,length:8}], 4)` → `[{start:1,length:3},{start:4,length:5}]`; toggling 4 again merges back.
  - panel renders roles per row ("Skipped", "Header", "Detail", "Record header", "Trailer"), the low-confidence notice text, the not-supported notice with Next off, and for a config maker the folded summary without Change.
- [ ] Step 2: `bunx vitest run src/features/sources/steps/file-read*.test.ts` → FAIL.
- [ ] Step 3: implement (design: spec "Web: the File inbox step"; Change = kind segmented control + that kind's fields + records table; ruler for fixed_width).
- [ ] Step 4: PASS; `bunx vitest run --maxWorkers=4 src/features/sources src/test` → PASS; typecheck; lint.
- [ ] Step 5: commit `feat(web): how the file is read, detected and correctable`.

### Task 7: Docs, check, deploy

- [ ] Step 1: `docs/recon/deploy.md` (EXCEL_MAX_MB, samples folder), `docs/decisions.md` DEC-058 (one reader, formats, detection, samples), README Sources line, AGENTS.md dependency note for `xlsx` (ingest only).
- [ ] Step 2: `bun run check` alone (no other test run against the test DB meanwhile); the 17 known environment failures (base-identical) allowed, nothing new.
- [ ] Step 3: commit `docs: file reader`.
- [ ] Step 4: deploy on tibsdev as Inbox files did (ff main, chmod go+rX, build with proxy args, `run --rm migrate`, `up -d`).
- [ ] Step 5: smoke in the browser on "Demo inbox": an H/D/T pipe file, a fixed-length file, a two-sheet xlsx and a PDF in Inbox files; each picked in the wizard shows the expected summary or notice; screenshots to the owner.
