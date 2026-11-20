import { fieldLabel, recordFields, type SourceSpecLike } from "@starterkit/shared/recon";
import type { DbEngine } from "@starterkit/shared/sources";
import { specHash } from "../../kernel/versions";

// The version rules every maker-checker module shares live in kernel/versions.ts (sources and recon).
export { canStep, specHash, specIssue, type VersionStep } from "../../kernel/versions";

/**
 * Whether `next` reads the source differently from `saved` (spec §7 step 3a: the table, query, watermark, schedule,
 * folder, pattern and file format are a source admin's): any difference, or nothing saved to compare with.
 */
export const readsDifferently = (next: unknown, saved: unknown): boolean => saved == null || specHash(next) !== specHash(saved);

const ENGINE_NAME: Record<DbEngine, string> = { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server", oracle: "Oracle" };
/** The server's version as people say it: PostgreSQL "18.6 (Homebrew)" → 18.6, MySQL "8.0.36-0ubuntu" → 8.0.36, Oracle 19.0.0.0.0 → 19c. */
export function shortVersion(engine: DbEngine, v: string): string {
  const n = /^\d+(\.\d+)*/.exec(v.trim())?.[0] ?? "";
  if (engine !== "oracle" || !n) return n;
  const major = Number(n.split(".")[0]);
  return major >= 23 ? `${major}ai` : major >= 12 ? `${major}c` : n;
}
const count = (n: number, one: string, many: string, more = false) => `${n.toLocaleString("en-US")}${more ? "+" : ""} ${n === 1 && !more ? one : many}`;

/** What a passing test found (REC-F2a); a part left null was not read in time and leaves its clause out. */
export type TestFound = {
  version: string | null;
  /** The login, shown only for a typed connection (a stored one's user is part of its credential). */
  user: string | null;
  database: string | null;
  /** The test ran on the engine's default database: no table count, the user picks one. */
  defaulted: boolean;
  databases: { n: number; more: boolean } | null;
  tables: { n: number; more: boolean } | null;
};

/**
 * The passing test's sentence (designer's SPEC, REC-F2a): "Connected to PostgreSQL 16.4 as recon_ro. 3 databases; 128
 * tables in recon_core." / "… 3 databases. Choose one to list its tables." / Oracle "Connected to Oracle 19c (PRD) as
 * RECON_RO. 4 schemas with tables you can read." Any number not read is left out; with nothing read, "Connected to X."
 */
export function testSentence(engine: DbEngine, f: TestFound): string {
  const v = f.version ? shortVersion(engine, f.version) : "";
  const head = `Connected to ${ENGINE_NAME[engine]}${v ? ` ${v}` : ""}${engine === "oracle" && f.database ? ` (${f.database})` : ""}${f.user ? ` as ${f.user}` : ""}.`;
  if (engine === "oracle") return f.databases ? `${head} ${count(f.databases.n, "schema", "schemas", f.databases.more)} with tables you can read.` : head;
  const dbs = f.databases ? count(f.databases.n, "database", "databases", f.databases.more) : null;
  if (f.defaulted) return dbs ? `${head} ${dbs}. Choose one to list its tables.` : head;
  const tables = f.tables && f.database ? `${count(f.tables.n, "table", "tables", f.tables.more)} in ${f.database}` : null;
  const tail = [dbs, tables].filter(Boolean).join("; ");
  return tail ? `${head} ${tail}.` : head;
}

/**
 * The sentence when the engine's default database refused this login (the test or list ran without a database typed):
 * the same as a failed list, with the way out (designer's SPEC, PO decision 7).
 */
export const defaultRefused = (database: string, code: string | null) =>
  `The database list couldn't be loaded: this account can't open the default database ${database}${code ? ` (${code})` : ""}. Type the database name instead.`;

/**
 * The record fields `next` drops or retypes against the published `before` (Plan 3 A4): gone, of another kind, or read
 * from a source field whose declared type changed. `label` names it as the person editing the source knows it: the
 * source field it was read from, else the field's own label.
 */
export function fieldChanges(before: SourceSpecLike, next: SourceSpecLike): { ref: string; label: string }[] {
  const after = recordFields(next);
  return [...recordFields(before)].filter(([ref, b]) => {
    const a = after.get(ref);
    return !a || a.kind !== b.kind || (b.fromType !== null && a.fromType !== null && a.fromType !== b.fromType);
  }).map(([ref, b]) => ({ ref, label: b.from ?? fieldLabel(ref) }));
}

/** Why a source version can't go ahead: each field it drops or retypes and the published recons that read it. */
export function usedBySentence(changes: { ref: string; label: string }[], used: Map<string, string[]>): string | null {
  const byLabel = new Map<string, Set<string>>();
  for (const c of changes) for (const n of used.get(c.ref) ?? []) byLabel.set(c.label, (byLabel.get(c.label) ?? new Set()).add(n));
  const lines = [...byLabel].map(([label, names]) => {
    const list = [...names].sort();
    return `Field ${label} is used by ${list.length} published recon${list.length === 1 ? "" : "s"}: ${list.join(", ")}.`;
  });
  return lines.length ? lines.join(" ") : null;
}

/**
 * What a spec means for its rows that a save doesn't refuse (Plan 3 sign rule, at save time): direction read from a
 * column carries the sign, so a negative amount is quarantined (ingest map.ts); a CEL-derived direction says nothing.
 */
export function specWarnings(spec: SourceSpecLike & { mapping: { direction?: { field: string } | { cel: string } } } | null): string[] {
  const d = spec?.mapping.direction;
  return spec?.mapping.amount_minor && d && "field" in d ? ["Negative amounts are quarantined because direction comes from a column."] : [];
}
