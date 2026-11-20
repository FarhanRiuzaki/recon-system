// The source wizard's working state and the rules its steps share (no React): what the user has typed, how a spec is
// built from it, which control an API error belongs to, and which values a connection test ran with.
import type { ConnectionTestDto, SourceColumnsDto, SourcePreviewDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import { DEFAULT_CALENDAR, type DbEngine, SOURCE_CODE, type SourceKind } from "@starterkit/shared/sources";
import { FILE_DATE } from "../spec-draft";

/** A database connection as typed: never filled from the server (the credential is never answered). */
export type Conn = { engine: DbEngine; host: string; port: string; database: string; user: string; password: string; tls: boolean };
export type Column = SourceColumnsDto["columns"][number];
export type Draft = {
  name: string; code: string; kind: SourceKind; conn: Conn;
  /** A watermark source reads a table or its own SELECT. */
  from: "table" | "query";
  spec: SourceSpec;
  /** Core fields filled from the column names, by core field: the note shows while the value is still it. */
  hint?: Partial<Record<"business_date" | "amount_minor" | "currency" | "ext_ref" | "account_ref", string>>;
};
/** The one error on screen: the control it belongs to and why. */
export type FieldErr = { id: string; reason: string } | null;
export type Tested = { result: ConnectionTestDto; key: string };
export type Preview = { result: SourcePreviewDto | null; error: string | null; pending: boolean };

export const DEFAULT_PORT: Record<DbEngine, string> = { postgres: "5432", mysql: "3306", mssql: "1433", oracle: "1521" };
export const EMPTY_CONN: Conn = { engine: "postgres", host: "", port: DEFAULT_PORT.postgres, database: "", user: "", password: "", tls: false };

/** The id of the control that edits spec path `path` ("mapping.amount_minor" → "src-mapping-amount_minor"). */
export const ctl = (path: string) => `src-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
/** The control on screen nearest to `path` (its own, else a parent's: fields.3.format.scale → fields.3), or null. */
export function controlOf(path: string): string | null {
  for (let p = path; p; p = p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "") if (document.getElementById(ctl(p))) return ctl(p);
  return null;
}

/** The spec a new source starts from, per kind: nothing declared yet, the defaults the API documents. */
export function emptySpec(kind: SourceKind): SourceSpec {
  const input: SourceSpec["input"] = kind === "file_inbox"
    ? { kind, path: "", pattern: "", completion: { kind: "stable_seconds", seconds: 60 }, format: { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" } }
    : kind === "db_snapshot" ? { kind, query: "", schedule: "0 6 * * *" }
      : { kind, table: "", watermark: { column: "", id_column: "" }, lookback_seconds: 300, chunk: 5000 };
  return {
    fields: [], mapping: { business_date: kind === "file_inbox" ? FILE_DATE : { field: "" }, attrs: {} }, derive: {}, key_fields: [], mutable: false,
    calendar: DEFAULT_CALENDAR, input,
  };
}

/** The values a connection test runs with: a pass counts only while they stay the same (ruling 1, Build notes 02). */
export const connKey = (d: Draft): string => {
  const i = d.spec.input;
  return JSON.stringify(d.kind === "file_inbox" && i.kind === "file_inbox" ? [i.path.trim(), i.pattern.trim()] : d.conn);
};
/**
 * The connection on screen differs from the one the wizard opened with (engine, port, TLS or any credential field):
 * it replaces the stored one, so every field is needed and it is tested as typed (fix round 1, I2).
 */
export const connChanged = (c: Conn, from: Conn) => JSON.stringify(c) !== JSON.stringify(from);
/** The typed connection as the API takes it (PUT …/connection, a typed test, the create body). */
export const connBody = (c: Conn) => ({ engine: c.engine, host: c.host.trim(), port: Number(c.port), database: c.database.trim(), user: c.user.trim(), password: c.password, options: { tls: c.tls } });

/**
 * The spec as sent: attrs only of fields that exist, a watermark source's table or query (not both), names trimmed.
 * `drop` = fields whose column the table no longer has and that nothing uses (REC-F2a): kept on screen, not sent.
 */
export function buildSpec(d: Draft, drop: readonly string[] = []): SourceSpec {
  const s = { ...d.spec, fields: d.spec.fields.filter((f) => !drop.includes(f.name)) };
  const names = new Set([...s.fields.map((f) => f.name), ...Object.keys(s.derive)]);
  const attrs = Object.fromEntries(Object.entries(s.mapping.attrs).filter(([, r]) => !("field" in r) || names.has(r.field)));
  let input = s.input;
  if (input.kind === "db_watermark") {
    const { table, query, ...rest } = input;
    input = d.from === "table" ? { ...rest, table: (table ?? "").trim() } : { ...rest, query: (query ?? "").trim() };
  }
  // a derived value still being typed (no name or no expression) is left out until it has both
  const derive = Object.fromEntries(Object.entries(s.derive).filter(([k, v]) => k.trim() && v.trim()));
  return { ...s, mapping: { ...s.mapping, attrs }, derive, key_fields: s.key_fields.filter((k) => names.has(k)), input };
}

/** Why step 1 can't go on yet, per control, in screen order (shown after Test or Next is pressed). */
export function connectionProblems(d: Draft, o: { created: boolean; replace: boolean }): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  const need = (ok: boolean, id: string, reason: string) => { if (!ok) out.push({ id, reason }); };
  if (!o.created) {
    need(!!d.name.trim(), "src-name", "Enter a name for the source.");
    need(SOURCE_CODE.test(d.code.trim().toLowerCase()), "src-code", "Use 2 to 64 letters, digits, - or _, starting with a letter or digit.");
  }
  const i = d.spec.input;
  if (i.kind === "file_inbox") {
    need(i.path.trim().startsWith("/"), ctl("input.path"), "Enter the folder as a full path, starting with /.");
    need(!!i.pattern.trim() && !/[/\\]/.test(i.pattern), ctl("input.pattern"), "Enter a file name pattern without folders, such as act*.txt.");
    return out;
  }
  const c = d.conn;
  if (o.replace) {
    need(!!c.host.trim(), "src-host", "Enter the host.");
    need(/^\d{1,5}$/.test(c.port) && +c.port >= 1 && +c.port <= 65535, "src-port", "Enter a port from 1 to 65535.");
    // a database may stay empty for the test (the engine's default; the list then offers them), Oracle's service name not
    need(c.engine !== "oracle" || !!c.database.trim(), "src-database", "Enter the service name.");
    need(!!c.user.trim(), "src-user", "Enter the username.");
    need(!!c.password, "src-password", o.created ? "Enter the password again: the connection changed." : "Enter the password.");
  }
  return out;
}

/**
 * Why step 1 can't go on yet once the test passed (checked on Next): a connection to store needs its database, the pull
 * its query or table; the watermark is step 2's.
 */
export function pullProblems(d: Draft, o: { replace: boolean } = { replace: false }): { id: string; reason: string }[] {
  const i = d.spec.input;
  const out: { id: string; reason: string }[] = [];
  if (d.kind !== "file_inbox" && o.replace && !d.conn.database.trim()) out.push({ id: "src-database", reason: "Choose the database, or type its name." });
  if (i.kind === "db_snapshot") {
    if (!/:business_date\b/.test(i.query)) out.push({ id: ctl("input.query"), reason: "Write the SELECT with the :business_date parameter." });
    if (!i.schedule.trim()) out.push({ id: ctl("input.schedule"), reason: "Enter when it runs, as a cron expression." });
  }
  if (i.kind === "db_watermark") {
    if (d.from === "table" && !(i.table ?? "").trim()) out.push({ id: ctl("input.table"), reason: "Enter the table, as table or schema.table." });
    if (d.from === "query" && !(i.query ?? "").trim()) out.push({ id: ctl("input.query"), reason: "Write the SELECT." });
  }
  return out;
}

/** Why a watermark source's watermark and id columns aren't picked yet (step 2, where the columns are read). */
export function watermarkProblems(d: Draft): { id: string; reason: string }[] {
  const i = d.spec.input;
  if (i.kind !== "db_watermark") return [];
  return [
    ...(i.watermark.column ? [] : [{ id: ctl("input.watermark.column"), reason: "Pick the column that grows when a row is added or changed." }]),
    ...(i.watermark.id_column ? [] : [{ id: ctl("input.watermark.id_column"), reason: "Pick the column that tells rows with the same watermark apart." }]),
  ];
}

/** Why step 2 can't be previewed or saved yet (no field, no business date). */
export function mappingProblem(s: SourceSpec): { id: string; reason: string } | null {
  if (!s.fields.length) return { id: "src-columns", reason: "Read the columns first: a sample of the file, or the source's table." };
  const b = s.mapping.business_date;
  if ("field" in b && !b.field) return { id: ctl("mapping.business_date"), reason: "Pick where the business date comes from." };
  return null;
}

/** The nullable reason of a watermark or id column option (ruling 4): rows with no value would never be pulled. */
export const NULLABLE_REASON = "This column can be empty; rows with no value would never be pulled.";
