// The SQL that builds and fills core.source1 and core.source2 of recon_source_test (docs/recon/source-test-db.md):
// source-test-db.ts runs it against recon_source_test, the engine's answer-key test (Plan 3) against <test database>_src.
// Run it inside one transaction (its temp tables are ON COMMIT DROP), with schema core in place.
// Data deterministik (generate_series, tanpa random()), sintetis (prefiks TST).

// Kunci k per skenario (ref = TSTREF + k 6 digit). Tiap tabel tepat 1000 baris:
//   1..940 cocok | 941..955 amount beda | 956..965 tanggal beda | 966..970 ref ganda di source1 (source2 satu)
//   971..975 ref ganda di source2 (source1 satu) | 976..995 hanya source1 | 996..1015 hanya source2
const KEYS = `
  CREATE TEMP TABLE keys ON COMMIT DROP AS
  SELECT k, CASE WHEN k<=940 THEN 'match' WHEN k<=955 THEN 'amount' WHEN k<=965 THEN 'date'
                 WHEN k<=970 THEN 'dup1' WHEN k<=975 THEN 'dup2' WHEN k<=995 THEN 'only1' ELSE 'only2' END AS kind
  FROM generate_series(1,1015) k;
  CREATE TEMP TABLE s1k ON COMMIT DROP AS
  SELECT row_number() OVER (ORDER BY k, c) AS id, k, kind FROM keys, generate_series(1, CASE WHEN kind='dup1' THEN 2 ELSE 1 END) c
  WHERE kind <> 'only2';
  CREATE TEMP TABLE s2k ON COMMIT DROP AS
  SELECT row_number() OVER (ORDER BY k, c) AS id, k, kind FROM keys, generate_series(1, CASE WHEN kind='dup2' THEN 2 ELSE 1 END) c
  WHERE kind <> 'only1';`

/** The tables, their rows and, when `ro` names a role, its SELECT grants. */
export const sourceTestTables = (ro?: string) => `
  DROP TABLE IF EXISTS core.source1, core.source2;
  CREATE TABLE core.source1 (
    id bigint PRIMARY KEY,
    txn_ref text NOT NULL,
    business_date date NOT NULL,
    amount_minor bigint NOT NULL,
    ccy char(3) NOT NULL,
    account_no text NOT NULL,
    settled_at timestamptz,
    updated_at timestamptz NOT NULL
  );
  CREATE INDEX source1_updated_at_idx ON core.source1 (updated_at, id);
  CREATE TABLE core.source2 (
    id bigint PRIMARY KEY,
    reference text NOT NULL,
    value_date date NOT NULL,
    amount bigint NOT NULL,
    currency char(3) NOT NULL,
    acct text NOT NULL,
    note text,
    updated_at timestamptz NOT NULL
  );
  CREATE INDEX source2_updated_at_idx ON core.source2 (updated_at, id);
  ${KEYS}
  INSERT INTO core.source1
  SELECT id, 'TSTREF' || lpad(k::text, 6, '0'),
         date '2026-11-02' + (k % 3),
         100000 + (k * 7919) % 5000000,
         CASE WHEN k % 10 = 0 THEN 'USD' ELSE 'IDR' END,
         'TSTACC' || lpad((k % 50)::text, 4, '0'),
         CASE WHEN k % 4 = 0 THEN NULL ELSE timestamptz '2026-11-02 12:00+00' + (k % 3) * interval '1 day' END,
         timestamptz '2026-11-17 08:00+00' + (id / 4) * interval '17 minutes'
  FROM s1k;
  INSERT INTO core.source2
  SELECT id, 'TSTREF' || lpad(k::text, 6, '0'),
         date '2026-11-02' + (k % 3) + CASE WHEN kind = 'date' THEN 1 ELSE 0 END,
         100000 + (k * 7919) % 5000000 + CASE WHEN kind = 'amount' THEN 50000 ELSE 0 END,
         -- TSTREF000931..933: the same reference and amount in another currency on this side ("Currency differs").
         CASE WHEN k BETWEEN 931 AND 933 THEN 'USD' WHEN k % 10 = 0 THEN 'USD' ELSE 'IDR' END,
         'TSTACC' || lpad((k % 50)::text, 4, '0'),
         CASE WHEN k % 5 = 0 THEN 'TSTNOTE ' || k ELSE NULL END,
         timestamptz '2026-11-17 08:00+00' + (id / 3) * interval '19 minutes'
  FROM s2k;
  ${ro ? `GRANT USAGE ON SCHEMA core TO ${ro};
  GRANT SELECT ON core.source1, core.source2 TO ${ro};` : ''}`
