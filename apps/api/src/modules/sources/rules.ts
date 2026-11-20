import { createHash } from "node:crypto";
import { $ZodError } from "zod/v4/core";
import type { DbEngine, VersionStatus } from "@starterkit/shared/sources";

/** `v` with every object's keys sorted, at any depth; arrays keep their order (field order means something). */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;

/** SHA-256 (hex) of the spec as canonical JSON: the same spec gives the same hash whatever order its keys came in. */
export const specHash = (spec: unknown): string => createHash("sha256").update(JSON.stringify(canonical(spec))).digest("hex");

/** The status a version must be in for each step: edit and submit a draft; approve or reject one in review. */
const FROM = { edit: "draft", submit: "draft", approve: "in_review", reject: "in_review" } as const satisfies Record<string, VersionStatus>;
export type VersionStep = keyof typeof FROM;
export const canStep = (step: VersionStep, status: VersionStatus): boolean => FROM[step] === status;

/**
 * Why the contract refused a spec, naming the field ("Check mapping.amount_minor: The amount needs …."), when the reason
 * was written for a person (a refine or a pattern with its own message); null for any other schema miss (the fixed 400).
 * `root` is where the spec sits in the body. The same shape as a CEL error ("Check the expression at derive.x: …").
 */
export function specIssue(e: unknown, root = "spec"): string | null {
  if (!(e instanceof $ZodError)) return null;
  // a union (the preview body) holds each option's issues, with paths relative to the union's
  type Issue = (typeof e.issues)[number];
  // a record's refused key (an attrs name) holds its own issues, at the key's path
  const flat = (xs: Issue[], at: PropertyKey[] = []): Issue[] => xs.flatMap((x) => x.code === "invalid_union"
    ? flat(x.errors.flat(), [...at, ...x.path])
    : x.code === "invalid_key" ? flat(x.issues as Issue[], [...at, ...x.path]) : [{ ...x, path: [...at, ...x.path] }]);
  const i = flat(e.issues).find((x) => x.path[0] === root && (x.code === "custom" || (x.code === "invalid_format" && !x.message.startsWith("Invalid"))));
  if (!i) return null;
  const why = i.message.charAt(0).toUpperCase() + i.message.slice(1);
  return `Check ${i.path.slice(1).join(".")}: ${why}${/[.?]$/.test(why) ? "" : "."}`;
}

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
