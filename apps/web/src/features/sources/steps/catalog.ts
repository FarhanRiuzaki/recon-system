// The wizard's database and table pickers (REC-F2a, designer's SPEC .superpowers/scratch/rec-f2/SPEC.md), without
// React: what a list was read for and when it is out of date, the copy of each state, the watermark and id the columns
// suggest, and the fields a new table no longer has.
import type { SourceCatalogDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import type { DbEngine } from "@starterkit/shared/sources";
import { formatNumber, plural } from "@starterkit/ui/lib/format";
import { fieldTypeOf, storedName } from "../spec-draft";
import type { Column, Conn } from "./model";

export type CatalogTable = Extract<SourceCatalogDto, { list: "tables" }>["items"][number];
export type TablesPage = Extract<SourceCatalogDto, { list: "tables" }>;
/** A list's state: not asked yet, loading, failed (Retry from `retryAt`, ms epoch, after a 429), or read. */
export type ListState<T> = { status: "idle" } | { status: "loading" } | { status: "error"; message: string; retryAt: number | null } | { status: "ready"; data: T };
export const IDLE = { status: "idle" } as const;

/** The connection values a list was read with, apart from the database: a change of any makes the lists out of date. */
export const credKey = (c: Conn) => JSON.stringify([c.engine, c.host.trim(), c.port, c.user.trim(), c.password, c.tls]);

export const STALE_NOTE = "The connection changed since the last test. Test it again to refresh this list.";
export const DATABASE_NOTE = "Leave it empty to choose from a list after Connect.";
export const TYPED_NOTE = "As the source's catalog spells it, such as schema.table. Checked when the columns are read.";
export const EMPTY_DATABASES = "This account can't open any database on this server. Ask IT to grant access.";
export const goneNote = (name: string) => `${name} isn't in the list for this account any more.`;
export const emptyTables = (db: string) => `This account can't read any tables in ${db}. Ask IT to grant SELECT.`;
export const noMatch = (q: string) => `No table matches "${q}".`;
/** The second line of a table row: "table · 18 columns". */
export const tableLine = (t: CatalogTable) => `${t.kind} · ${plural(t.columns, "column", "columns")}`;
const totalText = (p: TablesPage) => `${formatNumber(p.total)}${p.totalCapped ? "+" : ""}`;
/** The list footer when one page doesn't hold every match; null when it does. */
export const truncatedText = (p: TablesPage) => (p.next ? `Showing ${formatNumber(p.items.length)} of ${totalText(p)} tables. Type to narrow the list.` : null);
/** The polite live line: "50 of 1,284 tables shown". */
export const shownText = (p: TablesPage) => `${formatNumber(p.items.length)} of ${totalText(p)} tables shown`;
/** A failed list: the API's sentence after what failed (a refused default database already says it). */
export const listFailed = (what: "table" | "database" | "schema", message: string) =>
  (message.startsWith("The database list couldn't be loaded") ? message : `The ${what} list couldn't be loaded. ${message}`);

/** A table's `schema.name` as a spec names it; MySQL's schema is the connected database, so the name alone. */
export const tableValue = (engine: DbEngine, t: CatalogTable) => (engine === "mysql" ? t.name : `${t.schema}.${t.name}`);

const WATERMARK_NAME = /(^|_)(updated|modified|last_?update)/i;
export type Suggestion = { column: string | null; id: string | null; idWhy: string | null };

/**
 * The watermark and id a table's columns suggest (PO decision 5): only NOT NULL columns. Id = a primary key or unique
 * column; none → no id, with the reason. Watermark = a date-time named like updated_at, modified or last_update, an
 * indexed one first.
 */
export function suggest(engine: DbEngine, columns: readonly Column[], table: string, kind: "table" | "view" | null): Suggestion {
  const solid = columns.filter((c) => c.nullable === false);
  const time = (c: Column) => fieldTypeOf(engine, c.type).type === "datetime" || (engine === "oracle" && /^date$/i.test(c.type.trim()));
  const named = solid.filter((c) => time(c) && WATERMARK_NAME.test(c.name));
  const column = (named.find((c) => c.indexed) ?? named[0])?.name ?? null;
  const id = solid.find((c) => c.unique === true)?.name ?? null;
  const short = table.split(".").pop() ?? table;
  const idWhy = id ? null : kind === "view"
    ? "No id suggested: views have no primary key. Choose a column that is unique and never empty."
    : `No id suggested: ${short} has no primary key or unique column. Choose a column that is unique and never empty.`;
  return { column, id, idWhy };
}
export const watermarkNote = (_name: string) => "Suggested";
export const idNote = (_name: string) => "Suggested";

/**
 * The fields whose column the table read last doesn't have (PO decision 4: kept and marked, never removed), and of
 * them the ones still used: stored, mapped to a core field or in the match key. An unused one is left out of the spec.
 */
export function goneFields(spec: SourceSpec, columns: readonly Column[] | null): { gone: string[]; used: string[] } {
  if (!columns) return { gone: [], used: [] };
  const have = new Set(columns.map((c) => c.name));
  const gone = spec.fields.map((f) => f.name).filter((n) => !have.has(n));
  const mapped = new Set(Object.entries(spec.mapping).flatMap(([k, r]) => (k !== "attrs" && r && typeof r === "object" && "field" in r ? [r.field as string] : [])));
  const used = gone.filter((n) => storedName(spec, n) !== null || mapped.has(n) || spec.key_fields.includes(n));
  return { gone, used };
}
export const goneRowNote = (table: string) => `Not in ${table.split(".").pop()}. Map it to another column or set it to Not stored.`;
export const goneBlocked = (n: number, table: string) => `${plural(n, "field refers", "fields refer")} to columns that ${table.split(".").pop()} doesn't have.`;
