# Import section (monitoring first, then host feeds) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global sidebar group **Import** (under Setup) with **Monitoring** and **Feeds**. Part A ships Monitoring
over `import_file_history`, so the owner watches import-host's KAI / INDOVISION / GARUDA feeds (late, missing, failed
dates, locks left) while the Python cron still runs. Part B adds the engine: the host connection, query, target table
`stg_<biller>_host`, mapping, code rules, schedule and late-data rules on screen, a run log that detects missed and
stuck schedulers, and the switch away from the cron when the owner chooses.

**Architecture:** A new API module `imports` owns four tables in recon-system (`import_feeds`, `import_checks`,
`import_runs`, and in Part B `import_connections`). Staging is a second Bun SQL pool (`STAGING_DATABASE_URL`):
`import_file_history` through a Drizzle table object kept outside `schema.ts` (we never migrate it), the dynamic
`stg_*` tables and their DDL through validated identifiers. DWH reads go through the ingest module's SQL Server
connector (snapshot path: the feed's SELECT wrapped, every column cast to text on the server). The engine is a port of
import-host's `src/` on worker queue `imports.run`, writing the same history rows, so history continues and both
engines share the PROCESSING lock.

**Tech Stack:** Bun 1.4.3, Elysia, Drizzle on PostgreSQL 18, `mssql` 12.7.15, `@marcbachmann/cel-js` 8.0.0, pg-boss,
Next.js 16 BFF, zod contracts in `packages/shared`, Vitest and `bun test` (all existing).

**Spec:** `docs/superpowers/specs/2026-11-27-import-host-design.md`. Decision: DEC-066. Rules: `AGENTS.md`.
Reference code to port: `/root/apps/import-engine/import-host/src/{history,engine,loader,database,extractor,dwh}.py`,
`feeds/host_biller.py`, its `CLAUDE.md` (the verified mapping table). Read them before Tasks 4, 7, 11 and 12.

## Global Constraints

- **DWH is SELECT-only** (owner rule, `~/.claude/CLAUDE.md`): nothing but one plain SELECT ever reaches it, in code,
  tests or scripts. Tests use a fake driver (`connectorOver`); no test connects to the DWH. The only real DWH reads are
  the manual read-only checks of Task 15.
- Staging writes go only to `STAGING_SCHEMA` of `STAGING_DATABASE_URL`; tests use schema `imports_staging` of
  `<database>_test`, never the real staging database. **Part A never writes to staging** (reads only).
- History rows exactly as import-host writes them: `source` = feed's `historySource` (`KAI_TLHIST` …), `file_name` =
  `<batchPrefix>:<YYYY-MM-DD>`, `file_date`, `file_size` = rows fetched, `file_hash` = sha256 (Task 11).
  `historySource` and `batchPrefix` can't change once the feed has a history row (409 `invalid_state`); `historySource`
  is unique across feeds.
- A feed may be saved **incomplete** (only name, kind, history source, batch prefix, start date, due) while its
  scheduler is off: Monitoring works on it. Turning the scheduler on requires the complete spec, a host connection and
  the table `created` or `adopted`.
- Permissions: `import.view` (read, preview, monitoring), `import.manage` (everything else; implies view).
- Navigation: `NavGroup` + `"import"` with label "Import", placed right after `setup` in `NAV_GROUPS`; items
  **Monitoring** `/imports` (shortcut "G G": every earlier letter of the label is taken) and **Feeds** `/imports/feeds`
  ("G F"); both `perm: "import.view"`, no `space`. No Connections item.
- Connections: one **host connection** shared by every host feed (`import_connections.scope = 'host'`), edited from the
  Feeds page; a biller/file feed's connection (later) is owned by that feed (`scope = 'feed'`, `feed_id` unique) and
  never shared.
- Alerts: the Monitoring badge and an on-screen notice on the Import pages; no email, no other channel.
- Activity actions (target `import_feed` / `import_connection`): `import.feed.create`, `.update`, `.delete`,
  `.schedule` (after `{ on }`); `import.connection.create`, `.update`; `import.table.create`, `import.table.adopt`,
  `import.table.column`; `import.run` (dates, dryRun), `import.rerun`, `import.retry`, `import.release` (date, run id).
- Scheduler: a feed starts **off**. On = one pg-boss schedule per run time, key `<feedId>@<HHmm>`, cron
  `mm HH * * *` (Asia/Jakarta); off = all unscheduled. Queue `imports.run`, stately, keyed per feed, concurrency 1.
- `STAGING_DATABASE_URL` empty: routes that touch staging answer 409 `invalid_state` "The staging database isn't set
  up on this server."; the pages show that sentence as their empty state.
- UI copy English, sentence case (AGENTS.md §10). Out of scope: biller/FTP feeds, data rollback, maker-checker, email,
  the downstream link to sources (spec §9).

## Review Focus

1. Monitoring states match the history exactly: a date with an IMPORTED row after a FAILED one is Imported/Late, not
   Failed; a SUPERSEDED-only date is Missing; a PROCESSING row older than 60 min is "Lock left". Task 4.
2. Missed vs ran-with-nothing-to-do: a scheduled run with no pending date still writes an `import_runs` row; a run
   time + 10 min without a run row is Missed; a `running` row with a 2 min old heartbeat is Stuck. Tasks 4 and 13.
3. The SELECT guard refuses each forbidden keyword in code and accepts it inside a string literal or as part of an
   identifier (`INTO_DATE`); `[CREATE]` is refused. Task 6.
4. Two runs (or this engine and a hand-inserted Python PROCESSING row) on one date → one IMPORTED row and one set of
   stg rows. A revision deletes every earlier version's rows in the same transaction; a failure keeps the previous
   version's rows. Task 12.
5. DDL: a name outside the patterns never reaches SQL; the dedupe index the engine queries is built from the same
   definition as the one it creates. Task 10.
6. The host-biller mapping in CEL reproduces `host_biller.map_row` on fixture rows and, read-only, on every real date
   since 2026-10-31. Tasks 7 and 15.

---

# Part A — Monitoring (watches import-host as it runs today)

### Task 1: Shared contracts, permissions, vocabulary

**Files:**
- Modify: `packages/shared/src/permissions.ts` (`{ key: "import", actions: ["view", "manage"] }`, `PermissionName`)
- Create: `packages/shared/src/imports.ts` (zod-free: `STG_TABLE_NAME = /^stg_[a-z0-9]+(_[a-z0-9]+)*_host$/`,
  `COLUMN_NAME = /^[a-z][a-z0-9_]{0,62}$/`, `HISTORY_SOURCE = /^[A-Z][A-Z0-9_]{1,62}$/`, `COLUMN_TYPES`,
  `SYSTEM_COLUMNS`, `RUN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/`, `PREVIEW_ROWS = 50`, `MONITOR_DAYS = 14`,
  `DATE_STATES` (`waiting`, `not_ready`, `imported`, `late`, `missing`, `failed`, `rerun`), `SCHEDULER_STATES` (`ok`,
  `missed`, `stuck`, `lock_left`, `connection_failing`, `off`), `START_GRACE_MINUTES = 10`, `HEARTBEAT_STALE_SECONDS =
  120`, `LOCK_STALE_MINUTES = 60`)
- Create: `packages/shared/src/contracts/imports.ts`
- Modify: `packages/shared/src/audit.ts` (`ACTION_LABEL`), `packages/shared/src/paging.ts` (feeds `name`,
  `updatedAt`; runs/checks `at`; history `createdAt`, `fileDate`)
- Modify: `apps/web/scripts/emit-api-schemas.ts` (import, `named`, `COMPOSED`: `ImportFeedPage`, `ImportRunPage`,
  `ImportCheckPage`, `ImportHistoryPage`)
- Test: `packages/shared/src/imports.test.ts`, `apps/web/src/test/api-contract.test.ts`

**Interfaces (contracts/imports.ts):**
- `ImportFeedSpec` (every part after `due` optional until the scheduler goes on):
  ```ts
  { kind: "db_host"; historySource: string; batchPrefix: string; startDate: string;
    due: { time: string; graceMinutes: number };
    connectionId?: string; query?: string; readinessQuery?: string;      // :julian_mis_date / :mis_date
    table?: { name: string; columns: { name: string; type: ColumnType; length?: number; precision?: number;
              scale?: number; required: boolean; allowed?: string[] }[];
              dedupe: { column: string; normalize: boolean }[] };
    mapping?: { column: string; expr: string }[];
    codeRules?: { column: string; rules: { code: string; sourceType: string; transactionType: string; verified: boolean }[] } | null;
    schedule?: { times: string[]; maxMinutes: number };                    // maxMinutes: stuck after (default 30)
    revision?: "none" }
  ```
- `ImportFeedBody = { name, spec }`; `ImportFeedDto = { id, name, spec, schedulerOn, tableState: "missing" | "created" |
  "adopted", complete: boolean, missing: string[] (what blocks the scheduler), updatedAt }`; `ImportFeedRowDto`.
- `ImportMonitorQuery = { to?: string }` → `ImportMonitorDto = { now, workerAlive: boolean, dates: string[],
  today: Record<DateState, number>, feeds: { id, name, schedulerOn, scheduler: { state: SchedulerState, lastRun:
  ImportRunDto | null, nextRun: string | null, message: string | null }, cells: { date, state: DateState, rows: number |
  null, at: string | null, message: string | null }[] }[] }`
- `ImportIssuesDto = { count: number }` (the badge)
- `ImportRunDto = { id, feedId, trigger: "schedule" | "manual", scheduledFor, startedAt, heartbeatAt, finishedAt,
  status: "running" | "done" | "failed" | "crashed", dates: number, message, by }`
- `ImportCheckDto = { id, date, at, trigger, result, rows, inserted, replaced, historyId, message, by }`
- `ImportHistoryDto` (one `import_file_history` row) and `ImportDateDto = { date, state, checks: ImportCheckDto[],
  versions: ImportHistoryDto[] }`
- Part B adds: `ImportConnectionBody/Dto`, `ImportPreviewBody/Dto`, `ImportTableDdlDto`, `ImportAdoptDto`,
  `ImportRunBody = { from, to, dryRun }` (≤ 62 dates), `ImportDateBody = { date }`, `ImportReleaseBody = { runId? , date? }`.

- [ ] **Step 1:** Failing tests: the patterns' accepted and refused samples (`stg_kai_host` / `stg_kai_biller`,
  `KAI_TLHIST` / `kai`, `06:30` / `6:30`); `withViews(["import.manage"])` has `import.view`.
- [ ] **Step 2:** `bunx vitest run src/imports.test.ts src/permissions.test.ts` in `packages/shared` → FAIL.
- [ ] **Step 3:** Implement. **Step 4:** PASS; `bun run typecheck`.
- [ ] **Step 5:** Commit `feat(shared): import contracts, permissions and vocabulary`.

### Task 2: Config, staging pool (read), test harness

**Files:**
- Modify: `apps/api/src/kernel/config.ts` (`STAGING_DATABASE_URL` optional, `STAGING_SCHEMA` default `public`
  (`^[a-z_][a-z0-9_]*$`), `STAGING_HISTORY_TABLE` default `import_file_history`, `STAGING_READONLY_ROLE` default
  `readonly` ("" = no grant), `STAGING_POOL_MAX` default 2; validated, never logged)
- Create: `apps/api/src/modules/imports/staging/pool.ts` (lazy Bun `SQL` + Drizzle, opened on first use; statement
  timeout `JOB_STATEMENT_TIMEOUT_MS` in the worker, 5 s in the API; `staging()` throws the 409 above when unset)
- Create: `apps/api/src/modules/imports/staging/history-table.ts` (Drizzle table for `import_file_history` under
  `pgSchema(STAGING_SCHEMA)`; outside `schema.ts`, so drizzle-kit never creates it here)
- Create: `apps/api/test/fixtures/staging.sql` (import-host's `create_import_history.sql` + `2026-11-18_rerun_status.sql`,
  schema as a placeholder)
- Modify: `apps/api/test/helpers/preload.ts` (`STAGING_DATABASE_URL` = test URL, `STAGING_SCHEMA=imports_staging`,
  `STAGING_READONLY_ROLE=""`; create the schema + fixture once), `apps/api/test/helpers/app.ts` (`resetStaging()`:
  drop `stg_%` tables, truncate history), `test/helpers/staging.ts` (`historyRow({...})` inserts a row as Python would)
- Modify: `.env.example` files, `docker-compose.yml` (API and worker allow-lists), `scripts/setup.ts` (left empty)
- Test: `kernel/tests/unit/config.test.ts`, `modules/imports/tests/integration/staging.test.ts`
- [ ] Steps: failing tests → implement → PASS → commit `feat(imports): staging database pool and test harness`.

### Task 3: Module, feeds (incomplete allowed), runs and checks tables

**Files:**
- Create: `apps/api/src/modules/imports/{schema,service,controller,rules,index}.ts`
  - `import_feeds`: `id`, `name` (unique lower), `kind` (`db_host`), `connection_id` (null; fk added in Task 8),
    `spec` jsonb, `scheduler_on` bool default false, `table_state` default `missing`, timestamps, `updated_by`.
  - `import_runs`: `id` uuidv7, `feed_id` fk cascade, `trigger`, `scheduled_for` null, `started_at`, `heartbeat_at`,
    `finished_at` null, `status`, `dates` int, `message`, `user_id` null; index (`feed_id`, `started_at` desc), partial
    index on `status = 'running'`.
  - `import_checks`: `id` uuidv7, `feed_id` fk cascade, `run_id` null, `file_date`, `at`, `trigger`, `result`, `rows`,
    `inserted`, `replaced`, `history_id` null, `message`, `user_id` null; index (`feed_id`, `file_date`, `at` desc).
- Migration `cd apps/api && bun run db:generate -- --name=imports`; `modules/index.ts`; `db/janitor.ts`
  (`purgeImports`: runs and checks past `AUDIT_RETENTION_DAYS`, 10,000 a table a run); `db/seed/demo.ts` (two demo
  feeds, scheduler off, history sources `DEMO_A_TLHIST`, `DEMO_B_TLHIST`)
- Routes: `GET /v1/imports/feeds` (paged), `GET …/:id`, `POST …`, `PATCH …/:id`, `DELETE …/:id` (refused while the
  scheduler is on; stg table and history untouched). Save checks for what is present (spec §4, Task 9 adds the rest):
  history source pattern and unique, batch prefix, start date, due time; history source/prefix frozen once a history row
  exists. `complete` / `missing` computed by `rules.ts` `blockers(feed)`.
- Docs: `docs/api/README.md` rows, `bun run api:schemas`; `AGENTS.md` (§1 modules, §12 ownership)
- Test: `tests/integration/feeds.test.ts` (guard, 400 before guard, 404, duplicate, frozen source, activity),
  `tests/unit/rules.test.ts` (`blockers`)
- [ ] Steps → commit `feat(imports): module, feeds and the run and check logs`.

### Task 4: Monitoring API

**Files:** `apps/api/src/modules/imports/{monitor,rules,service,controller}.ts`, `staging/history-read.ts`, tests
`tests/unit/monitor.test.ts`, `tests/integration/monitor.test.ts`

- `dateState({ date, versions, lastCheck, due, now })` (pure): RERUN present → rerun; an IMPORTED row → imported, or
  late when the first IMPORTED `finished_at` > due; a current FAILED and no IMPORTED → failed; a check `not_ready` → not
  ready; now ≥ due → missing; else waiting. Due of MIS date D = D + 1 at `due.time` + `graceMinutes` (Asia/Jakarta).
- `schedulerState({ feed, runs, lockRows, lastCheck, now })` (pure), first that applies: `off` (scheduler off and no
  lock left), `lock_left` (a PROCESSING row of the feed's source older than 60 min, also when off: Python's), `stuck`
  (a `running` run with heartbeat older than 120 s or started more than `maxMinutes` ago), `missed` (a run time + 10 min
  passed today with no run whose `scheduled_for` is it, scheduler on), `connection_failing` (last check failed with a
  connection error), `ok`. `nextRun` from the run times.
- Routes (`import.view`, all in `NON_LIST_GETS` but the paged ones): `GET /v1/imports/monitor`, `GET
  /v1/imports/issues` (the badge: Missing + Failed cells in the last 14 days + schedulers missed/stuck/lock left/
  connection failing + 1 when the worker is down), `GET /v1/imports/feeds/:id/dates/:date`, `GET
  /v1/imports/feeds/:id/history` (paged with `pageQuery` on the staging Drizzle), `GET …/runs`, `GET …/checks` (paged).
- One history query per page load: `source IN (…) AND file_date BETWEEN …` for every feed (index
  `ix_import_file_history_source_file` + `file_date`); runs and checks the same.
- Tests: every `dateState` / `schedulerState` branch (the review-focus cases), a feed with only Python rows, a date with
  FAILED then IMPORTED, worker down counted once, staging unset → 409.
- [ ] Steps → commit `feat(imports): monitoring, issue count, date detail and history`.

### Task 5: Web: Import group, Monitoring, Feeds (Part A)

**Files:** `apps/web/src/lib/shared/nav.ts` (+ `nav.test.ts`: group order, shortcuts), `components/shell/nav-icon.tsx`,
`packages/ui/src/ui/icons.ts` (icons for Monitoring and Feeds, shown on `/ds/foundations`), `components/shell/sidebar.tsx`
(the Monitoring badge from `/api/imports/issues`, every minute and on focus; global, apart from the space nav counts),
`lib/shared/queries.ts` (keys `["imports", …]`, table defs), `lib/server/prefetch.tsx`, `lib/shared/prefs.ts`
(`VIEW_PAGES` for `/imports/feeds`), `features/imports/{use-imports.ts,monitoring-page.tsx,scheduler-table.tsx,
date-grid.tsx,date-dialog.tsx,runs-table.tsx,issues-notice.tsx,feeds-page.tsx,feed-form.tsx,shapes.ts}`,
`app/(main)/imports/{page,loading}.tsx`, `app/(main)/imports/feeds/{page,loading}.tsx`, `…/feeds/new/page.tsx`,
`…/feeds/[feedId]/{page,loading}.tsx`, `components/route-shapes.ts`, `docs/standards/copy-guide.md` (nav labels)

- Monitoring (spec §8.3): worker-down banner; "Today" KPI tray; Schedulers panel (state chip + legend in the card, last
  and next run); Data panel (date grid, scrolls inside its card, cell opens the date dialog with checks and versions);
  Run log (server `DataTable`, saved views, columns menu). The issues notice on every Import page links here.
- Feeds list and a Part A feed form (name, history source, batch prefix, start date, due time and grace); the feed page
  shows what still blocks the scheduler (`missing`).
- [ ] Steps: tests (nav, page guards with `pagePerm`, prefetch, the state labels) → implement →
  `bun run --filter @starterkit/web test` → commit `feat(web): import monitoring and feeds`.

**Part A done:** the owner enters KAI_TLHIST, INDOVISION_TLHIST, GARUDA_TLHIST (batch prefix `HISTORY_TLHIST`, start
2026-10-31, due 06:00 + 30) and watches them. Run `bun run check` and the Part A E2E (Task 16's lists for these pages)
before going on.

# Part B — The engine

### Task 6: SELECT guard and the julian date parameter (ingest connectors)

**Files:** `apps/api/src/modules/ingest/connectors/{dialect,index}.ts`, `ingest/service.ts` (callers),
`ingest/tests/unit/dialect.test.ts`

- `checkSelect`: blank string literals, then refuse `\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|INTO|BACKUP|RESTORE|DBCC|SHUTDOWN|KILL|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b`
  (case-insensitive) with "The query must be a plain SELECT: <WORD> isn't allowed."; applies to source queries too.
- `fromSql` binds `:julian_mis_date` as an integer parameter from `From.julianDate`; `Connector.pullSnapshot(query,
  { businessDate, julianDate? }, o)`.
- Tests: every keyword refused (`select * into x from y`, `exec`, `openrowset`); string literal, `INTO_DATE`,
  `[CREATED_AT]` accepted; `[CREATE]` refused; `:julian_mis_date` bound, `::julian_mis_date` untouched; existing cases
  pass; `bun test src/modules/ingest src/modules/sources`.
- [ ] Steps → commit `feat(ingest): plain-SELECT keyword guard and the :julian_mis_date parameter`.

### Task 7: CEL for import mappings

**Files:** `apps/api/src/modules/ingest/cel.ts` (`celCompiler(vars, extra?)`, exported from `ingest/index.ts`),
`apps/api/src/modules/imports/mapping.ts`, `imports/rules.ts` (`validateRow`), tests `tests/unit/{mapping,rules}.test.ts`

- Variables `row`, `code`, `out` (maps of text); functions `parse_date(s, fmt)` (`ddMMyy`, `ddMMyyyy`, `yyyyMMdd`,
  `yyyy-MM-dd` → `YYYY-MM-DD`, "" when not a date), `add_days(s, n)`, `scale(s, n)` (exact decimal shift),
  `parse_time(s, "HHmmss")` → `HH:MM:SS`; registered for the import compiler only.
- `mapRow(raw, codeRules, compiled)`: code gate first ("TLBTCD 4733 has no rule" / "TLBTCD 4625 is not verified yet"),
  then columns in order, each seeing earlier ones in `out`.
- `validateRow(values, table)`: required, allowed values, shape per type (date, time, numeric precision/scale, integer).
- Tests: functions' edge cases; host-biller fixture rows from import-host's mapping table: Success, Failed (`TLTXOK`),
  Failed (`TERR01`), Reversal pair, RMAPID for a DWH code, `time` = token 3 of `TLBTPN`, `CHANNEL ID ` removed only at the
  start, `jurnal_seq`, `business_date` across a month end; unknown and unverified codes; a source compiler refuses `scale`.
- [ ] Steps → commit `feat(imports): CEL mapping with date, decimal and time helpers`.

### Task 8: Host connection

**Files:** `imports/schema.ts` (`import_connections`: `id`, `scope` (`host` | `feed`), `feed_id` null unique (fk
cascade, for `feed` scope later), `name`, `engine` (`mssql`), `secret_enc`, `options` jsonb, timestamps, `updated_by`;
`import_feeds.connection_id` fk restrict), migration `--name=import_connections`, `service.ts`, `controller.ts`,
`tests/integration/connections.test.ts`

- Routes: `GET /v1/imports/connections/host` (the host connection or 404), `PUT …/host` (create or update; password
  required on create, left out = unchanged), `POST …/host/test` (stored) and `POST /v1/imports/connections/test`
  (typed): 20/min per user, log user, engine, host, port, result only; answer like `ConnectionTestDto`. A host feed
  points at the host connection automatically.
- Tests: guard, password never answered nor logged, activity, 21st test 429, the dialog's "used by N host feeds" count.
- [ ] Steps → commit `feat(imports): the shared host connection`.

### Task 9: Feed config (complete) and preview

**Files:** `imports/{service,controller,rules,preview}.ts`, `tests/integration/{feeds,preview}.test.ts`

- Save checks for the Part B parts: queries pass `checkSelect` and use `:julian_mis_date` or `:mis_date`; table name,
  columns, types, system columns not listed, dedupe columns exist; every mapping column is a table column and every
  required column mapped; every CEL compiles; run times valid and distinct, `maxMinutes` 5–240; `codeRules.column` in
  the query's select list. A spec change while the scheduler is on reschedules (Task 13).
- `POST /v1/imports/feeds/:id/preview` and `POST /v1/imports/feeds/preview` (unsaved spec): readiness, then the query
  for the date (stream counted to the end, cap 100,000), hash over all rows, the first 50 mapped with errors, unmapped
  codes grouped; interactive deadline; 60/min per user; one log line. Fake driver in tests.
- [ ] Steps → commit `feat(imports): complete feed config and preview`.

### Task 10: Target table (create, adopt, add column)

**Files:** `imports/staging/table.ts`, `tests/integration/table.test.ts`; `apps/api/test/architecture/boundaries.test.ts`
(`RAW_SQL_OK["src/modules/imports/staging/"]` with its reason)

- `ddlOf(table)`: columns, allowed-value checks (literals through a quoting function), system columns,
  `file_history_id` index, `ux_<name>_dedupe` from the dedupe definition, the readonly grant; identifiers only after the
  patterns, quoted.
- `GET …/feeds/:id/table/ddl`, `POST …/table` (one transaction; 409 when it exists), `POST …/table/adopt` (catalog
  columns + dedupe index from `pg_indexes`; differences listed; `adopted` only when they match), `POST …/table/columns`
  (one nullable column).
- Tests: the template's DDL matches `create_stg_garuda_host.sql` in substance; create then adopt matches; a changed type
  shows a difference.
- [ ] Steps → commit `feat(imports): create or adopt the staging table`.

### Task 11: History writes (port of `history.py`) and the content hash

**Files:** `imports/staging/history.ts`, `imports/hash.ts`, `tests/integration/history.test.ts`, `tests/unit/hash.test.ts`

- `decide`, `pendingDates`, `claim` (`ON CONFLICT … WHERE status = 'PROCESSING' DO NOTHING`), `markImported`,
  `markFailed` (≤ 4,000 chars), `releaseFailed`, `setRerun`, `releaseLock` (PROCESSING older than 60 min →
  SUPERSEDED "released by <user>").
- `contentHash(columns, rows)`: sha256 of sorted lines of `|`-joined trimmed values (null → "") in column order.
- Tests ported from import-host's recorded checks (MISSING, RERUN on IMPORTED/FAILED, mistaken SUPERSEDED in
  `replaceIds`, identical hash skips, changed hash revises, live vs stale PROCESSING); a fixed fixture's hash equals the
  hex computed by import-host's algorithm (written in the test).
- [ ] Steps → commit `feat(imports): history writes with import-host's semantics`.

### Task 12: The engine, the worker, the run log

**Files:** `imports/{engine,worker}.ts`, `imports/staging/load.ts`, `apps/api/src/kernel/jobs.ts`
(`QUEUES.importsRun`), `apps/api/src/worker.ts`, `tests/integration/engine.test.ts`

- Every job opens an `import_runs` row (`scheduled_for` from the job data), heartbeats every 30 s, closes it done /
  failed; a job that dies leaves it `running` (Stuck in Monitoring) and the next job of the feed marks such rows
  `crashed`.
- `processDate` = import-host's `process_date` (readiness → fetch → hash → decide → claim → map, validate, dedupe in
  batch, delete `replaceIds` rows, existing-key lookup, insert by 1,000, markImported; one transaction; error → rollback
  + markFailed); dry run = read-only staging transaction, nothing claimed. One `import_checks` row per outcome.
- `runPending(feed)`: preflight (table exists) → `pendingDates(startDate, yesterday)` → still-FAILED dates noted →
  `processDate` each. Job data `{ feedId, dates?, force?, dryRun?, trigger, scheduledFor?, userId? }`.
- Tests (fake driver, real staging schema): new date; 0 rows; not ready; rerun replaces; reversal pair → 1 row; invalid
  row fails the date and keeps the old version; two `processDate` at once → one IMPORTED, one skipped; a hand-inserted
  PROCESSING row → skipped; dry run writes nothing; a run with no pending date still writes its run row.
- [ ] Steps → commit `feat(imports): the import engine and its run log`.

### Task 13: Scheduler, manual actions, release

**Files:** `imports/{service,controller}.ts`, `tests/integration/actions.test.ts`

- `POST …/feeds/:id/scheduler` `{ on }` (409 with the blockers when incomplete), `POST …/run` (`ImportRunBody`,
  enqueues), `POST …/rerun`, `POST …/retry` (`ImportDateBody`), `POST …/release` (`ImportReleaseBody`: a Stuck run →
  crashed, a Lock left row → SUPERSEDED; 409 when neither is stale). Activity for each.
- `syncSchedule(feed)`: unschedule `<feedId>@*`, schedule each run time when on (job data carries `scheduledFor`).
- Tests: on/off/time change schedules; incomplete feed can't go on; release refused on a fresh lock.
- [ ] Steps → commit `feat(imports): scheduler, run now, rerun, retry and release`.

### Task 14: Web: feed page (Part B)

**Files:** `features/imports/{feed-page,source-tab,host-connection-dialog,table-tab,mapping-tab,schedule-tab,
feed-monitor-tab,history-table}.tsx`, Monitoring actions (`Run now`, `Release stuck run` with `ConfirmActionDialog`)

- Feeds page header: "Host connection" (dialog: form with `PasswordInput`, Test connection, "Applies to N host feeds").
- Feed tabs (spec §4.2): Source (host connection read-only + edit link, two queries in a monospace textarea, date,
  Preview), Table (columns editor, dedupe, DDL dialog, Create / Adopt / Add column), Mapping (column → expression,
  live mapped preview with errors, code rules), Schedule and rules (run times, max minutes, start date, due and grace,
  the scheduler switch with `ConfirmActionDialog` and its blockers), Monitor, History. "New feed from template: host
  biller" (Task 15). `useLeaveGuard` on editing tabs.
- [ ] Steps → commit `feat(web): import feed configuration`.

### Task 15: Host-biller template and the read-only comparison

**Files:** `packages/shared/src/imports.ts` (`HOST_BILLER_TEMPLATE`: the 20 DWH columns, the query with `<host codes>`,
`<dwh codes>`, `<provider>`, the 21 `stg_kai_host` columns with types and checks, dedupe `date`, `upper(btrim(ref_id))`,
`amount`, `ref_number`, the CEL mapping, code rules, 06:30/08:30, max 30 min, due 06:00 + 30),
`apps/api/scripts/imports-compare.ts`

- Template tests: KAI's generated query equals spec §4.3; the table equals `create_stg_kai_host.sql`.
- `imports-compare.ts <feedId> --from --to`: **SELECT only on the DWH, read-only staging transaction**; per date, dry-run
  `processDate`, compare mapped rows with the stg rows of the IMPORTED history id (all columns) and the hash with
  `file_hash`; print differences. Run for the three feeds from 2026-10-31 to yesterday once they are completed
  (scheduler off) and report the result to the owner.
- [ ] Steps → commit `feat(imports): host-biller template and the comparison script`.

### Task 16: E2E, docs, final check

- E2E: `permissions.spec.ts` (Viewer has no Import group; Admin opens Monitoring and Feeds), `responsive.spec.ts`,
  `responsive-data.spec.ts`, `a11y.spec.ts`, `no-flicker.spec.ts` (`PAGES` + `/imports`, `/imports/feeds`),
  `helpers.ts` `demoIds`; the e2e script prepares the staging schema like the preload.
- Docs: `AGENTS.md` (§1, §12 ownership, queue, `RAW_SQL_OK`, config keys), `docs/api/README.md`, `bun run api:schemas`,
  `docs/architecture.md` (staging pool), spec status → implemented.
- `bun run check`, `bun run e2e`, `NEXT_DIST_DIR=.next-e2e bun run build && bun run budget`.
- [ ] Commit `docs(imports): agents, api and architecture`.

## After the plan (owner)

Complete the three feeds from the template, adopt their tables, read the comparison, then turn the schedulers on and
comment out the import-host cron line when ready.
