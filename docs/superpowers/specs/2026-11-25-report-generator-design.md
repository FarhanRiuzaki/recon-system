# Report generator — design

Status: approved in conversation with the owner, 25 Nov 2026 (brainstorming); this document is the written design.

## Intent and why

A recon's results have to leave the system in fixed, provable shapes: daily recaps for ops, break lists for
investigation, and official reports for regulators and outside parties (OJK, KSEI, BI and others — the regulator is an
example, never hard-coded). Today only the activity log and the Open API call log export CSV (10,000 rows). The owner
wants report templates per recon, configured in the app, made as files in the background, kept, and downloaded with a
trail. The backlog items REC-FUT-8 (a full day's audit extract), REC-FUT-5 (masking customer data per role) and
REC-FUT-11 (per-day export for the parallel run with the legacy engine) should all be served by this module.

## Goals

- A recon has any number of **report templates**. A template says what it holds, which rows, which columns, how they
  are grouped and totalled, the output format, masking, and when files are made.
- Three kinds of content: **Transactions** (one row per item), **Grouped** (rows grouped by one or two columns with
  totals per group), **Daily summary** (per recon per business date: counts, matched/break, match rate, amounts, breaks
  per reason).
- Formats: **CSV**, **Excel (.xlsx)**, **PDF**.
- Files are made **in the background** (a queue), **stored**, and downloaded when ready. A file is never made again on
  download: what was sent to a regulator stays as it was.
- Two triggers: **after every run**, for the dates that run processed (templates marked so), and **on request**, for a
  date range the user picks.
- Every file records who or what asked for it, the template and its version, the dates, masking, and whether each date
  was closed (**Final**) or still open (**Not final**). Making a file and every download are activity log entries.
- A run done again on a date makes a **new file version**; the earlier file stays.
- Templates are **versioned** like recons. A template marked **Official report** needs a `config_checker`'s approval
  (approval workflow engine, DEC-052) before it is active; an internal template becomes active on submit.
- Masking of customer data (account, name) is a **template setting** (Masked / Full); Full is allowed only on an
  official template, so it always passed a checker.

## Non-goals

- Sending files out (email, SFTP, a regulator's API). Files are downloaded; delivery is a later step.
- Report templates across several recons in one file.
- A free-form report designer (drag elements on a page). The PDF layout is fixed per content kind.
- Regulator-specific formats written in code.

## Anti-goals (a failure even if it works)

- A file whose numbers change after it was made.
- An official report whose template changed without a checker.
- Customer data in full in a file nobody approved to hold it.
- A download nobody can trace.
- Report making that slows the API or the recon runs down (it runs in the worker, on its own queue, never in a request).

## UX (decided with the owner: "use the current recon behaviour, so it feels familiar"; ideas within the DS)

Teks layar English, sentence case (copy guide). Mockups: `.superpowers/brainstorm/…/reports-flow-v2.html`.

### Navigation

- New space menu item **Reports** (beside Recons and Sources), its own module: `reports` in the API and the web.
- Shortcut: the recon page gets a **Reports** tab: this recon's templates and latest files, "New report template"
  prefilled with the recon, "See all in Reports". The data belongs to the reports module; the recon tab only shows it
  (a feature never imports a sibling feature: the recon tab renders through the reports API, see "Web").
- The **run page** shows "Reports made by this run (N)" with links to the files (owner's idea 4).

### Reports page

Route tabs **Files** and **Templates** (grey-fill route tabs, design-system §5).

- **Files**: server `DataTable` with `FilterLayout` (recon, template, Final / Not final, made by: a run or a user,
  status), `SavedViewsMenu` and `ColumnsMenu` (idea 3: a saved view such as "Ready to send"). Columns: report (template
  name · version · format), recon, dates, status (`Making… 62%`, `Ready`, `Failed` with Try again), Final / Not final,
  made by (a run with its time, or a user), size, Download. Phone: stacked cards.
- **Templates**: server `DataTable`: name, recon, holds, format, Official, status (Draft, Waiting approval, Active,
  Retired), last file. "New report template".
- "Generate report" (page header): a dialog: template (active ones), date range (`DateRangeControl`'s absolute range);
  a notice when some of those dates aren't closed ("3 of these dates aren't closed yet: the report is marked Not
  final."); Generate → queued → toast "Making the report. You'll find it in Files." The new row appears with its
  progress.

### Template page (like the recon page)

Header with the active version and the draft's state; tabs **Overview** · **Files** · **Versions**. Versions is the
same `VersionLayout` and change chips as a recon's versions. Retire (⋯ menu, confirm) stops automatic files.

### New template

"New report template" first offers three filled starting points as `InteractiveCard`s (idea 1): **Daily summary**,
**Break detail**, **Matched list**, plus **Blank**. Each opens a draft already filled, to change.

### Draft: Wizard, five steps (the recon setup's pattern)

The draft saves itself (header "Saved / Saving… / Not saved · Retry"), "Discard draft" in ⋯, `Wizard` with the
"Setup progress" panel on the right, Next / Back, a step with an error marked in the panel.

1. **Content** — recon, name, holds (Transactions / Grouped / Daily summary), rows: filters on status (open, matched,
   suggested, break, closed, not required), side (A, B, both), break reason; reuse the recon's condition editor where
   it fits.
2. **Columns and groups** — columns from the recon's result columns (the Operation result columns and the core record),
   ordered by drag (`SortableList`, as passes), each with the header it gets in the file; Grouped: group by one or two
   columns, totals per group (count, sum, min, max of a number column); Daily summary: the fixed measures, which to show.
3. **Output** — CSV / Excel / PDF; file name pattern (`{recon}_{from}_{to}`, `{date}` for one date); customer data
   Masked (`····1234`) or Full (Full only when step 5 marks the template official; otherwise the choice is a
   `BlockedButton` reason); PDF: title and a line under it (e.g. who the report is for).
4. **Test** — makes a sample file from a real date or range the user picks (like the recon's Test), shows the first 50
   rows (CSV/Excel) or the first page (PDF) in the browser and lets the user download that sample (marked "Sample",
   never listed in Files). Daily summary's preview uses `StatTile` and `BreakdownCard` (idea 2); the PDF is printed in
   the same arrangement.
5. **Review and submit** — the version's changes, **When**: "After every run, for its dates" and "On request" (either
   or both), **Official report** (for a regulator or an outside party; needs a checker). Submit: official → approval
   request to the space's workflow; internal → active at once.

## Function and flow

### Triggers

- **After a run** finishes (succeeded), the engine queues one `reports.make` job per active template of that recon
  marked "after every run", for the run's business dates (one file per template per run, covering its dates). Through
  the reports module's index, after the run's commit, never inside it.
- **On request**: `POST …/reports/files` with a template and a date range → a queued file row (status `queued`) and a
  job. Range limits: at most 92 days per file (a guard; a longer one is refused with what to do).

### Making a file (worker, queue `reports.make`)

1. Read the template version, the rows (from `recon_items` / result columns, `recon_day_stats` for Daily summary) in
   pages, through `withSpace` and the worker's pool (`workerDb`, `JOB_STATEMENT_TIMEOUT_MS`).
2. Mask customer fields unless the version says Full.
3. Write the file to storage streaming (CSV), or in parts (Excel, PDF).
4. Record per date whether it was closed at the time (`recon_days`), the row count, size, SHA-256.
5. Status `ready` (or `failed` with a sentence and Try again). Progress is written every page so Files shows it.

Limits: PDF at most 5,000 rows (a Transactions template with PDF over that is refused at Test and at making, with
"Use CSV or Excel for more than 5,000 rows"); Excel 1,048,576 rows per sheet (Excel's own); CSV unbounded but streamed.
CSV cells are neutralized (`packages/ui/src/lib/csv.ts`).

### PDF (owner's choice A: HTML printed by headless Chromium)

The worker builds the report as an HTML page with the DS tokens (`packages/ui/src/styles/tokens.css`, the light theme)
and prints it with headless Chromium. The API may import only `@starterkit/ui/lib/*` (AGENTS §1), so the PDF's HTML is
written in the reports module itself (a small server-side template per content kind: header, stat tiles, breakdown,
table with repeated header rows, page numbers, Final / Not final and masking stamped on every page), styled with the
tokens, not with the React components. Chromium comes into the worker image (the API image; the API process never
launches it). Its versions are pinned exact. Chromium runs without network access to anything but the HTML it is
given (no external fonts or images; the Inter font file is bundled).

### Excel

SheetJS (already a dependency, DEC-058) writes the workbook. AGENTS §5 limits xlsx to `modules/ingest`; this design
extends it to `modules/reports` (a new decision record, DEC-060). Grouped and Daily summary templates put the totals
on their own rows, bold, with the group's name.

### Storage

On disk, beside Inbox files: `<space inbox root>/.reports/<file id>.<ext>`, not listed in Inbox files (a dot folder,
as `.samples`). Kept for `REPORT_RETENTION_DAYS` (default 400: a year and a margin for audits); the janitor removes
older files and their rows keep a "Removed after N days" state. MinIO/S3 later, with the inbox (same seam).

### Download

`GET …/reports/files/:id/download` streams the stored file with `Content-Disposition`; every call writes an activity
entry (`report.download`: file, template, version, dates, masking). The web's catch-all already passes
`content-disposition` through (AGENTS §3).

### Permissions (SPACE_ACTION, new lists)

- `viewReports`: every space role (see templates and files, download). Downloading a file with Full customer data
  needs `downloadFullReports`: `space_admin`, `reviewer`, `config_checker`.
- `editReports`: `config_maker` (create templates, edit and submit drafts, Test).
- `generateReports`: `space_admin`, `config_maker`, `operator`, `reviewer` (on request).
- Approving an official template: `approveVersion` (`config_checker`), maker-checker rule as recons (DEC-051).

## Data (module `reports`, all tables space-owned with the space policy)

- `report_templates` (space, recon, name, kind, active version, retired at).
- `report_template_versions` (template, version, spec JSON (content, rows, columns, groups, output, masking, when,
  official), status draft / waiting / active / rejected / superseded, made by, approved by).
- `report_files` (space, template, version, recon, from, to, format, status, progress, rows, size, sha256, masking,
  per-date closed flags, asked by user or run id, file version for the same dates, error, made at, removed at).
- The activity log carries `report.template.*`, `report.make`, `report.download`.

## Constraints

- AGENTS.md throughout: module shape (§13), route order, `SPACE_ACTION`, RLS on every table, Drizzle only, exact
  pinned dependencies, copy guide, five states per region, tokens only, bundle budget (the builder loads through
  `next/dynamic`).
- The worker image may grow (Chromium); the API container's own memory limit stays as it is; one PDF at a time per
  worker (queue concurrency 1 for PDF), CSV/Excel up to 2.
- tibsdev resource rule (memory: at most 2 heavy jobs).

## Approaches considered (owner picked A for PDF)

- **A. HTML printed by headless Chromium in the worker** — the PDF looks like the screens (tokens, same arrangement as
  the dashboard parts); costs ~300 MB of image and memory while printing. **Picked.**
- B. A light PDF library drawing tables in code — small and fast, but the layout lives apart from the DS.
- C. An external generator (JasperReports or similar) — rich, but another service to deploy, secure and keep, with
  templates outside the app.
- Module: a separate `reports` module with a shortcut tab on the recon (picked) vs templates inside the recon version
  (rejected: changing a report column would need a new recon version).
- Builder: the recon setup's Wizard (picked by the owner, "familiar") vs one long form.

## Left to the builder

- The exact HTML/CSS of each PDF kind within the DS tokens; how Chromium is driven (a pinned `playwright-core` or
  `puppeteer-core` with the distro's Chromium) — pick the lighter, pinned exact.
- Paging size for reading rows, progress granularity.
- Where in the engine the after-run hook sits (after the run's commit, through the reports index).

## Settled after the builder check (Claude's calls unless marked; the owner may overrule)

- **Approval**: a new approval kind `report_version` in the approvals module, built like `source_version` (a union arm
  in its inbox and facets): one `config_checker` approves, not the maker (DEC-051). No workflow steps: a report template
  has no money action, so the space's workflows (posting, write-off) don't apply. No `action_runs` outbox.
- **Read consistency**: rows are read in keyset pages (no transaction held for the job: the pool's timeouts forbid it).
  A file records the time it was read; its Final dates can't change under it (see "Final"), its Not final dates may,
  which is what the stamp says.
- **After every run**: the run's own business dates (its `from`..`to`), a real run only (never a simulation), and only
  a run that succeeded. Idempotent per (template, run): a retried job writes the same file row, never a second. A file
  for a template and dates that already have one is the next file version (`file version = n + 1`); the earlier stays.
- **Dates**: the 92-day cap is calendar days. Rows are chosen by the item's business date. A one-way recon's side B
  `not_required` items are a status like the others (the Content step's status filter offers it).
- **Masking**: customer fields are the core `account_ref` plus any result column the recon's result-column settings mark
  as customer data (a new flag there, default off); a Grouped key on a masked column groups by the real value and shows
  the masked one. File name tokens are recon, template, dates only (no column values), so names never hold customer
  data; activity entries never hold row data. A Test sample is always Masked.
- **Template lifecycle**: `config_maker` retires a template (⋯ menu, confirm); retiring needs no approval (it only
  stops new files; it is logged). A rejected draft is edited and sent again, as recons. A job uses the version that was
  active when it was queued.
- **Test sample**: stored 24 hours beside the files (`.reports/samples/`), fetched only by its maker, never listed;
  swept by the janitor like inbox samples.
- **Storage**: the inbox root is the same mount in the api and worker services (compose already mounts it in both); a
  file is written to a hidden temp name and renamed when complete, leftovers swept. Files of retired templates and
  archived spaces stay until their retention ends.
- **Chromium**: the distro's package (Debian `chromium`, version pinned) installed through the build proxy
  (`BUILD_HTTP_PROXY`, as the other images); driven by a pinned `playwright-core`.
- **Daily summary**: computed from the items of each date in the job (counts per status, amounts per currency, breaks
  per reason, match rate), not from `recon_day_stats` (a dashboard rollup without amounts or reasons). The items are
  the source of truth.

## Decided by the owner (25 Nov, after the builder check)

- **Final = signed off.** A date is Final once its day is signed off (`recon_days.signed_at`, items frozen by
  `day_closed`); closed but not signed off is Not final. The dialog's notice, the per-date flag and the PDF stamp use this.
- **Full customer data** is downloaded only by `space_admin`, `reviewer` and `config_checker` (`downloadFullReports`).
- **Retention**: `REPORT_RETENTION_DAYS` = 400 by default.
