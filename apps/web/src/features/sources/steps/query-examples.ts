import type { DbEngine } from "@starterkit/shared/sources";

// The examples under a database source's own SELECT, one per engine and pull (owner, 25 Nov: whoever writes a query sees
// how it is read). They follow what the connector sends (apps/api/src/modules/ingest/connectors/dialect.ts):
// - the query runs as `SELECT … FROM (<query>) t`, one SELECT or WITH, no `;`, no comments (checkSelect; SQL Server: no
//   WITH, and no ORDER BY inside the subquery);
// - `:business_date` becomes a date parameter (dateParam): Oracle TO_DATE(:p, 'YYYY-MM-DD'), the others CAST(… AS date);
// - a column's native type decides what field it can feed (ingest/rules.ts FITS): text only a String field.
// Notes are plain text; a `quoted` part shows as code.

export type QueryExample = { sql: string; notes: string[] };
type Pull = "db_snapshot" | "db_watermark";

const SNAPSHOT: Record<DbEngine, QueryExample> = {
  oracle: {
    sql: `SELECT
  b.ACCOUNT_NO,
  b.AMOUNT,
  b.POSTED_AT,
  :business_date AS BUSINESS_DATE
FROM APP.DAILY_BALANCE b
WHERE b.POSTED_AT >= :business_date
  AND b.POSTED_AT < :business_date + 1`,
    notes: [
      "`:business_date` arrives as a DATE: the run sends `TO_DATE('2026-11-24', 'YYYY-MM-DD')`. Use it as it is: `TO_DATE(:business_date, 'YYYY-MM-DD')` reads it again through the session's date format and can fail or give another day.",
      "The day before is `:business_date - 1`. A DATE column holds a time too: take one day with `col >= :business_date AND col < :business_date + 1`, or `TRUNC(col) = :business_date`.",
      "Keep a date column a DATE: `TO_CHAR(…)` makes it VARCHAR2, which only a String field can read.",
      "A name without quotes comes back in capitals (`amount` is AMOUNT): name the fields the same way.",
    ],
  },
  postgres: {
    sql: `SELECT
  b.account_no,
  b.amount,
  b.posted_at,
  :business_date AS business_date
FROM finance.daily_balance b
WHERE b.posted_at >= :business_date
  AND b.posted_at < :business_date + 1`,
    notes: [
      "`:business_date` arrives as a date: the run sends `CAST('2026-11-24' AS date)`. Use it as it is, without `to_date` or `to_char`.",
      "The day before is `:business_date - 1`; one day of a timestamp column is `col >= :business_date AND col < :business_date + 1`.",
      "Keep a date column a date or timestamp: `to_char(…)` makes it text, which only a String field can read.",
      "A name without quotes comes back in lower case.",
    ],
  },
  mysql: {
    sql: `SELECT
  b.account_no,
  b.amount,
  b.posted_at,
  :business_date AS business_date
FROM daily_balance b
WHERE b.posted_at >= :business_date
  AND b.posted_at < :business_date + INTERVAL 1 DAY`,
    notes: [
      "`:business_date` arrives as a DATE: the run sends `CAST('2026-11-24' AS DATE)`. Use it as it is, without `STR_TO_DATE` or `DATE_FORMAT`.",
      "The day before is `:business_date - INTERVAL 1 DAY`.",
      "Keep a date column a DATE or DATETIME: `DATE_FORMAT(…)` makes it text, which only a String field can read.",
    ],
  },
  mssql: {
    sql: `SELECT
  b.account_no,
  b.amount,
  b.posted_at,
  :business_date AS business_date
FROM dbo.daily_balance b
WHERE b.posted_at >= :business_date
  AND b.posted_at < DATEADD(day, 1, :business_date)`,
    notes: [
      "`:business_date` arrives as a date: the run sends `CAST('2026-11-24' AS date)`. Use it as it is, without `CONVERT`.",
      "The day before is `DATEADD(day, -1, :business_date)`.",
      "No WITH and no ORDER BY: the query is read as a subquery, where SQL Server refuses both. Write a WITH as a subquery in FROM.",
      "Keep a date column a date or datetime2: `CONVERT(varchar, …)` makes it text, which only a String field can read.",
    ],
  },
};

const SNAPSHOT_COMMON = [
  "`:business_date` is the date the snapshot is for: the business day before the run's day, in the source's calendar. Check query fills in today.",
  "Every row of a snapshot belongs to its date, so a business date column is optional. When you return one, keep it a date.",
  "Give every expression a name (`… AS QUANTITY`): it is the field's name. One SELECT, without `;` or comments; ORDER BY is not needed.",
];

const WATERMARK: Record<DbEngine, string> = {
  oracle: `SELECT
  t.TRX_ID,
  t.UPDATED_AT,
  t.ACCOUNT_NO,
  t.AMOUNT
FROM APP.TRANSACTIONS t
WHERE t.STATUS = 'POSTED'`,
  postgres: `SELECT
  t.trx_id,
  t.updated_at,
  t.account_no,
  t.amount
FROM finance.transactions t
WHERE t.status = 'POSTED'`,
  mysql: `SELECT
  t.trx_id,
  t.updated_at,
  t.account_no,
  t.amount
FROM transactions t
WHERE t.status = 'POSTED'`,
  mssql: `SELECT
  t.trx_id,
  t.updated_at,
  t.account_no,
  t.amount
FROM dbo.transactions t
WHERE t.status = 'POSTED'`,
};

const WATERMARK_NOTES: Record<DbEngine, string[]> = {
  oracle: ["A name without quotes comes back in capitals (`trx_id` is TRX_ID)."],
  postgres: ["A name without quotes comes back in lower case."],
  mysql: [],
  mssql: ["No WITH and no ORDER BY: the query is read as a subquery, where SQL Server refuses both."],
};

const WATERMARK_COMMON = [
  "Return the watermark column as it is (a date, a timestamp or a whole number that is never empty, not text through TO_CHAR or CAST) and the id columns that tell rows apart: you pick both in the next step.",
  "Leave out the watermark filter, ORDER BY and paging: each pull adds them to read only the rows after the last one, page by page.",
  "One SELECT, without `;`, comments or `:business_date`.",
];

/** The example SELECT and its notes for `engine` and the way the source is pulled. */
export function queryExample(engine: DbEngine, kind: Pull): QueryExample {
  return kind === "db_snapshot"
    ? { sql: SNAPSHOT[engine].sql, notes: [...SNAPSHOT[engine].notes, ...SNAPSHOT_COMMON] }
    : { sql: WATERMARK[engine], notes: [...WATERMARK_NOTES[engine], ...WATERMARK_COMMON] };
}

/** A note split into plain text (even places) and code (odd places, what stood between backticks). */
export const noteParts = (note: string): string[] => note.split("`");
