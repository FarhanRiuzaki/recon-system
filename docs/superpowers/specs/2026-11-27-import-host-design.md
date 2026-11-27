# Import menu, host feeds (DWH → stg): design

Status: **agreed with the owner** (27 Nov 2026), DEC-066.
Predecessor and reference: `/root/apps/import-engine/import-host` (Python, cron), whose behaviour this ports.

## 1. Goal and scope

A global **Import** section in the sidebar that loads staging tables in `recon_engine_import` and, first of all,
**monitors** them: per feed and date what has arrived, what is late, what failed, and whether each scheduler ran or is
stuck (late data and stuck schedulers are the frequent issues today). Everything import-host keeps in code becomes configuration on screen:
the DWH connection, the query, the target table `stg_<biller>_host` (created from the screen), the field mapping,
the schedule and the late-data rules.

First kind: **host feeds** (DWH `dbo.HISTORY_TLHIST` → `stg_<biller>_host`), covering today's KAI, INDOVISION, GARUDA.

Out of scope now: biller files from FTP (import-biller) and other files (they reuse this engine later, with a file
reader and an FTP readiness check); rolling data back; maker-checker.

## 2. Decisions taken with the owner (27 Nov 2026)

1. The menu is **global** (not per space): staging is one shared database.
2. **No maker-checker** on feed changes. Rollback is wanted for **data only**, and **not now**.
3. The flow stays **DWH/FTP → stg → recon-system source**. stg and `import_file_history` are where arrival is
   monitored and where late data leaves its history. recon-engine (the old Laravel app) is retired, so recon-system is
   the only reader of stg.
4. The **late-data rules** belong to the import side (import-host / import-biller), not to recon: when to check again,
   when a revision is taken, when it is ignored. They become per-feed settings.
5. Host first; biller and other files follow on the same engine.
6. **Navigation:** its own sidebar group **Import**, under Setup, with **Monitoring** (its own page, the group's
   entry) and **Feeds**. No Connections menu.
7. **Connections:** host feeds share one DWH connection (they read the same DWH). A biller or other file feed has its
   own connection inside the feed, never shared: each biller can differ.
8. **Alerts:** a badge on Monitoring and alerts on screen are enough; no email.
9. **Monitoring first:** it is built before the engine and watches import-host's feeds from `import_file_history`
   while the Python cron still runs.

## 3. Where things live

| What | Database | Owner |
|---|---|---|
| Connections, feeds (config), check log, run log | recon-system (`recon_engine`), Drizzle tables | new module `imports` |
| `stg_*` tables, `import_file_history` | staging (`recon_engine_import`) | external; written by `imports` through a second pool |
| `HISTORY_TLHIST` | DWH (SQL Server `stg_host`) | external; **SELECT only** |

- **Staging pool:** `STAGING_DATABASE_URL` (API and worker env, validated at boot), the same login import-host uses
  today (owner, 27 Nov), which already has CREATE in `public`. Its SQL is built by the module
  (identifiers validated and quoted, values bound), like the source connectors: an entry in `RAW_SQL_OK`
  (`src/modules/imports/staging/`) with that reason. Same statement timeout as the worker pool.
- **History continuity:** the engine writes the **same** `import_file_history` rows as Python: `source` =
  `KAI_TLHIST` / `INDOVISION_TLHIST` / `GARUDA_TLHIST`, `file_name` = `HISTORY_TLHIST:<date>`. So history goes on
  unbroken, and its partial unique index on PROCESSING is one lock for both engines while both can run (§10).
- **DWH access** goes through the ingest module's SQL Server connector (rule 9: the `mssql` driver is imported by
  `ingest/connectors/mssql.ts` only), exported through `ingest/index.ts`.

## 4. Concepts and screens

### 4.1 Connections (no menu of their own)

- **Host connection:** one DWH connection shared by every host feed, edited from the Feeds page ("Host connection")
  and shown read-only on each host feed's Source tab with a link to edit it (the dialog says it applies to all N host
  feeds). Engine (SQL Server), host, port, database, login, password (encrypted with `DATA_ENCRYPTION_KEY`, `v1:`;
  never answered), TLS, timeouts.
- **Biller / file feeds (later):** the connection (FTP or other) is part of that feed's Source tab and belongs to that
  feed only.
- Both: **Test connection** (20/min per user, logged without the login or password, as source tests are). A DWH
  connection's form states its read-only rule: every statement is checked to be one plain SELECT before it is sent.

### 4.2 Feeds (`/imports/feeds`, `/imports/feeds/<id>`)

List: feed, kind, target table, schedule (on / off), last date imported, today's state.

A feed's page has tabs:

1. **Source** — connection, the query, the readiness query, a date picker with **Preview** (runs both for that date,
   at most 50 rows, shows the columns and the hash the run would record).
2. **Table** — target table name, its columns, the dedupe key; **Create table** (shows the DDL first) or **Adopt**
   an existing table.
3. **Mapping** — each target column ← an expression over the query's columns, plus the code rules; a live preview of
   mapped rows for the picked date, with each row's validation errors.
4. **Schedule and rules** — run times, date range, revision policy, due time.
5. **Monitor** — this feed's scheduler health, date grid, run log and check log (§8).
6. **History** — `import_file_history` rows of this feed: versions per date, counts, errors.

### 4.3 The query

Shown and edited as text, with two parameters:

- `:julian_mis_date` — the MIS date as `YYYYDDD` (2026-11-03 → 2026307), the clustered index key; every query must
  filter on it (216M rows; a non-indexed date predicate scans the table, 22 s vs 1 s per day).
- `:mis_date` — the same date as a `date`.

KAI's query as it will appear (generated from `feeds/host_biller.py` + `feeds/kai.py`):

```sql
SELECT JULIAN_MIS_DATE, MIS_DATE, TLBTCD, TLBTDT, TLBJSN, TLBID, TLSVBR, TLBF01, TLBF04, TLBF15, TLBF16,
       TLBTPN, TLBDS1, TLBDS2, TERR01, TLTXOK, TLBDEL, TLBCOR, TLBDC1, RMAPID
FROM [dbo].[HISTORY_TLHIST]
WHERE JULIAN_MIS_DATE = :julian_mis_date
  AND (TLBTCD IN (4624, 4625) OR (TLBTCD IN (4785, 4788) AND RMAPID = 'PAY TICKET KAI'))
```

Readiness query (per feed, default shown): `SELECT TOP (1) 1 AS loaded FROM [dbo].[HISTORY_TLHIST] WHERE
JULIAN_MIS_DATE = :julian_mis_date`. No row → NOT READY (nothing loaded, checked again later); a row → ready, and
0 rows from the feed query is a real empty day (IMPORTED, 0 rows).

**SELECT-only guard (owner rule, `~/.claude/CLAUDE.md`):** every DWH statement passes `checkSelect` (one statement,
no comments, starts with SELECT/WITH) **and** a forbidden-keyword scan on the code outside string literals, ported
from `import-host/src/dwh.py` (`INSERT UPDATE DELETE MERGE TRUNCATE DROP ALTER CREATE EXEC EXECUTE GRANT REVOKE DENY
INTO BACKUP RESTORE DBCC SHUTDOWN KILL OPENROWSET OPENQUERY OPENDATASOURCE`). It runs on save, on preview and before
every send. The scan is added to the shared connector check, so source queries get it too. Tests: each keyword in code
refused; the same word inside a string literal or a column name such as `INTO_DATE` accepted.

**Content hash:** sha256 over the fetched rows, one line per row of `|`-joined trimmed values in the query's column
order, lines sorted (as `extractor.content_hash`). Number formatting from tedious may differ from Python's `str()`;
the scheduled run never re-reads an IMPORTED date, so a mismatch only shows on a manual rerun, as a REVISION that
replaces rows with equal rows.

### 4.4 Target table

- Name: `^stg_[a-z0-9]+(_[a-z0-9]+)*_host$`, at most 63 characters, unique in the staging schema.
- Columns: name (`^[a-z][a-z0-9_]*$`), type from a list (`varchar`, `char(n)`, `numeric(p,s)`, `integer`,
  `bigint`, `date`, `time`, `timestamptz`), required, an optional allowed-values check (`drcr` D/C,
  `source_type` HOST/DWH).
- System columns added to every table: `file_history_id uuid references import_file_history(id)` (indexed),
  `uuid uuid primary key default gen_random_uuid()`, `created_at`, `updated_at`.
- Dedupe key: chosen columns, each optionally normalised `upper(btrim(…))`; the unique index `ux_<table>_dedupe` is
  created from the same definition the engine uses for its lookup, so the two can't drift.
- **Create table**: shows the DDL, runs it in one transaction on the staging pool, adds the `readonly` grant.
  `STAGING_DATABASE_URL`'s login (import-host's) has CREATE on `public`.
- **Adopt**: for KAI / INDOVISION / GARUDA, which already exist. Reads the columns and indexes from the catalog and
  shows any difference from the feed's definition; runs no DDL.
- Once the table has rows: **add a nullable column** only. No rename, type change or drop from the screen.

### 4.5 Mapping

Each target column = one CEL expression over `row` (the query's columns as text) and `code` (the row's code rule).
The ingest CEL environment is reused (limits, allowlist, the compute steps) with a few new total functions:

| Function | For |
|---|---|
| `parse_date(s, "ddMMyy")` | `TLBTDT` (DMMYY, unpadded) |
| `add_days(d, n)` | `business_date` = date + 1 |
| `scale(s, -2)` | `TLBF04 / 100` as an exact decimal (no float) |
| `parse_time(s, "HHmmss")` | `time` from a token |

The host-biller mapping, as it will be pre-filled:

| Column | Expression |
|---|---|
| transaction_code | `row.TLBTCD` |
| date | `parse_date(pad_left(row.TLBTDT, "0", 6), "ddMMyy")` |
| card_number | `row.TLBF15` |
| amount | `scale(row.TLBF04, -2)` |
| sender_account_number | `pad_left(row.TLBF01, "0", 15)` |
| ref_id | `trimmed(row.TLBDS1)` |
| branch | `row.TLSVBR` |
| ref_number | `pad_left(row.TLBF16, "0", 12)` |
| terminal_id | `row.TLBID` |
| time | `parse_time(word_at(row.TLBTPN, 3), "HHmmss")` |
| remark | `trimmed(row.TLBTPN)` |
| channel_id | `trimmed(row.TLBDS2)` without a leading `CHANNEL ID` (as Python: only at the start) |
| status | `row.TLBDEL == "M" ? "Reversal" : (row.TLTXOK == "Y" && int(row.TERR01) == 0 ? "Success" : "Failed")` |
| transaction_type | `code.transaction_type != "" ? code.transaction_type : row.RMAPID` |
| rc | `row.TERR01` |
| drcr | `row.TLBDC1` |
| jurnal_seq | `first_chars(pad_left(row.TLBTDT, "0", 6), 4) + pad_left(row.TLBJSN, "0", 5)` |
| business_date | `add_days(out.date, 1)` (`out` = the columns mapped before it) |
| fee, merchant_id | empty |
| source_type | `code.source_type` |
| tlbf05/07/10 (Garuda) | `row.TLBF05` … |

Numeric source values reach `row` as integer text (`numeric(x,0)` → digits without sign or decimals, as
`extractor.digits`).

**Code rules** (a table on the Mapping tab): code column (`TLBTCD`), and per code: source type, transaction type
(empty = take `RMAPID`), **verified**. A row whose code is missing or not verified fails the whole date with the
codes and sample rows listed (as today, owner decision): check the mapping on those rows, tick verified, rerun the date.

**Validation:** the table's required columns and allowed values; any invalid row fails the date. A mapped `date` that
differs from the MIS date is a warning in the check log.

## 5. The engine (port of `import-host/src`)

Worker queue `imports.run`, stately and keyed per feed (one run of a feed at a time). Per feed × date, unchanged from
`engine.process_date`:

1. Readiness query → NOT READY (nothing written to history; a check log row) or ready.
2. Fetch, hash.
3. History decision on the staging pool (`history.decide`): RERUN → revision, forced; same hash IMPORTED → skip;
   same hash FAILED → skip until retried; changed hash → revision; else new. A stale PROCESSING row (60 min) is
   reclaimed.
4. Claim a PROCESSING row and commit (the cross-engine lock).
5. Map → validate → dedupe in the batch and against the table (excluding the rows being replaced) → delete the
   earlier versions' rows → insert → mark IMPORTED (older versions SUPERSEDED), one transaction. Any error rolls back
   and marks the row FAILED with its message.

**Scheduler on / off** per feed (`import.manage`, activity log): a new feed starts **off**; only the owner's switch
turns it on (§10). Off = no scheduled run; manual actions still work.

**Manual actions** (feed page, `import.manage`, each in the activity log):
- **Run now**: one date or a range; with **Dry run** ticked it reads DWH and staging, writes nothing to staging
  (read-only transaction) and records what it would have written in the check log, to check a feed before its
  scheduler is turned on.
- **Rerun date**: sets that date's IMPORTED/FAILED row to RERUN; the next run re-reads and replaces it. This replaces
  the hand-written `UPDATE … SET status = 'RERUN'`.
- **Retry failed**: retires the FAILED row (SUPERSEDED, "released by retry") so the date is taken again.

## 6. Schedule and late-data rules (per feed)

| Setting | Host default (today's behaviour) |
|---|---|
| Run times | 06:30 and 08:30 Asia/Jakarta (a list of times; stored as cron) |
| Dates to keep complete | from the feed's start date to yesterday |
| What a run takes | history-driven: every date in range without a current row (never run, NOT READY, released), plus RERUN, plus a stale PROCESSING; IMPORTED dates are not read again; FAILED dates wait for a person |
| Revision policy | host: none automatic (IMPORTED is final until Rerun). Biller later: a changed file is a revision only on the same day as the imported version, ignored after |
| Due time | 06:30 for host (the run time: the DWH is loaded before 05:45, the 06:30 run takes seconds), plus grace in minutes (30): a date imported by 07:00 WIB is on time |
| Scheduler | on / off; a new feed starts off |

## 7. Permissions and navigation

- `import.view` (screens, preview) and `import.manage` (connection, feeds, table DDL, manual actions); manage implies
  view (`withViews`). Superadmin gets both from the seed; the demo Admin gets them too.
- Navigation (owner, 27 Nov): a sidebar group of its own, **Import**, placed under Setup, global (no `space`), shown
  with `import.view`:
  - **Monitoring** `/imports` — the group's entry, with a count badge of open issues (§8);
  - **Feeds** `/imports/feeds`.
  Shortcuts are "G" plus the first free letter of the label (`nav.test.ts`), fixed in the plan.

## 8. Monitoring (`/imports`)

The page the owner opens first. Two kinds of issue, each detected from data, never guessed:

### 8.1 Data: per feed × date

States (feeds × the last 14 dates, scrolls inside its card; `StatusChip` + the legend in the card):

| State | When | Health colour |
|---|---|---|
| Waiting | not due yet, no data | unknown |
| Not ready | checked, source not loaded yet (time of the last check) | progress |
| Imported | IMPORTED before the due time; rows (0 is fine) | healthy |
| Late | IMPORTED after the due time | degraded |
| Missing | past due, still nothing | down |
| Failed | FAILED; its error | down |
| Rerun | set to RERUN, waiting for the next run | progress |

Due time of MIS date D = D + 1 day at the feed's due time + grace (host: 06:30 + 30 min = 07:00 WIB; a due time at the run time itself would make every 06:30 import late by seconds). Late = the first IMPORTED
`finished_at` past it. These states come from `import_file_history`, whoever wrote it, so they work for import-host's
feeds today (§10).

A cell opens the date: every check (time, result, rows, message), every history version (counts, replaced rows,
errors), Retry / Rerun.

### 8.2 Scheduler: per feed

New table **`import_runs`** (recon-system): one row per execution of a feed's job, also when it had no date to do:
feed, trigger (schedule / manual), `scheduled_for`, `started_at`, `heartbeat_at` (written every 30 s while running),
`finished_at`, status (running / done / failed / crashed), dates done, message. Without it "the scheduler ran and found
nothing to do" and "the scheduler never ran" look the same.

| State | Detected when | Usual cause |
|---|---|---|
| OK | the last scheduled run started within the start grace and finished | |
| Missed | a run time + start grace (10 min) passed with no run started for it | worker stopped, schedule lost, queue held by another run |
| Stuck | a run is `running` with `heartbeat_at` older than 2 min, or longer than the feed's max duration (default 30 min) | DWH query hanging, connection lost mid-run |
| Lock left | a PROCESSING history row older than 60 min | a crash, Python's included |
| Connection failing | the last check failed on the connection | DWH down or credentials changed |
| Off | the scheduler is off | not turned on yet, or on purpose |

**Worker down** (`workerAlive()` false) is a banner over the whole page.

Actions on a scheduler row (`import.manage`): **Run now**; **Release stuck run** (only when Stuck or Lock left: the
run row → crashed, the PROCESSING history row → SUPERSEDED "released by <user>", activity entry).

### 8.3 Page layout

1. Today: counts of on time, late, missing, failed, not ready; schedulers with an issue. A worker-down banner on top.
2. Schedulers: one row per feed (last run, next run, state, actions).
3. Data: the date grid (§8.1).
4. Run log: every run, filtered by feed and status.

### 8.4 Alerts (owner: badge and on-screen alerts, no email)

- **Badge** on Monitoring in the sidebar: open issues = cells Missing or Failed for the last 14 dates + schedulers
  Missed, Stuck, Lock left or Connection failing (+1 when the worker is down). Read every minute and on focus.
- **On screen:** a notice at the top of the Import pages while issues are open, naming them and linking to
  Monitoring.

### 8.5 Check log

Table `import_checks` (recon-system): feed, date, at, trigger, result (not_ready / imported / skipped / failed /
dry_run), rows, inserted, replaced, history id, message, user. NOT READY was in import-host's log file only, so
"checked at 06:30, not there; there at 08:30" was not visible. `import_checks` and `import_runs` are kept
`AUDIT_RETENTION_DAYS` (janitor).

## 9. Downstream (phase 2, later)

When a date is IMPORTED (0 rows included), the sources in recon-system that read that stg table are told: the date is
complete (`source_deliveries`), and their snapshot of that date is queued. This fixes today's gap where an empty
snapshot completes nothing (most host days have 0 rows). A source names the feed it reads; the exact link is designed
in phase 2.

## 10. Migration from the Python cron (owner, 27 Nov)

No formal parallel run: the owner decides when to switch.

0. **Monitoring first:** the three Python feeds are entered as feeds with only their history source, batch prefix,
   start date and due time (a feed may be saved incomplete while its scheduler is off), so §8.1 and "Lock left" watch
   them at once. Python's runs are not in `import_runs`, so until the switch a missed Python run shows as Missing
   data past the due time, not as Missed.
1. Build the rest of the module; the same feeds are completed from the template (query, mapping, code rules
   pre-filled), tables **adopted**, every scheduler **off**. import-host's cron keeps loading stg as today.
2. The owner checks feeds as they see fit (Preview, Run now with Dry run, the History tab against Python's batches).
3. **Switch, by the owner:** turn the feeds' schedulers on and comment out the import-host cron line
   (`# DISABLED <date> (moved to recon-system Imports)`, as import-kai-host was). Python stays frozen in its repo as
   the reference.
4. Back to Python: schedulers off, cron line back. History is shared, so either engine continues where the other
   stopped.

If both run for a while (scheduler on before the cron is off, or a manual Run now), nothing loads twice: they share
`import_file_history`, a date already IMPORTED is not read again, and a date being loaded is held by its PROCESSING
row (the partial unique index), so the second engine skips it.

## 11. Open questions for the owner

1. Later (owner: "bahas nanti"): biller (FTP) next, right after the switch, or the downstream link (§9) first?
