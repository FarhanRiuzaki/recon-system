import { describe, expect, it } from "vitest";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { credKey, emptyTables, goneBlocked, goneFields, goneNote, listFailed, noMatch, shownText, suggest, tableLine, tableValue, truncatedText } from "./catalog";
import { type Column, EMPTY_CONN } from "./model";

const col = (name: string, type: string, nullable: boolean | null, unique: boolean | null = false, indexed: boolean | null = false): Column => ({ name, type, nullable, unique, indexed });

describe("suggest (PO decision 5)", () => {
  const cols = [col("id", "bigint", false, true, true), col("ref", "text", false, true, true), col("created_at", "timestamp with time zone", false, false, true),
    col("modified", "timestamp without time zone", false), col("updated_at", "timestamp with time zone", false, false, true), col("note", "text", true)];
  it("id = the first NOT NULL unique column; watermark = a NOT NULL time named like updated_at, an indexed one first", () => {
    expect(suggest("postgres", cols, "core.bifast_tx", "table")).toEqual({ column: "updated_at", id: "id", idWhy: null });
    expect(suggest("postgres", cols.filter((c) => c.name !== "updated_at"), "core.bifast_tx", "table").column).toBe("modified");
  });
  it("a nullable column is never suggested; no unique column = no id, with the reason (a view says views have no key)", () => {
    const loose = [col("id", "bigint", true, true, true), col("updated_at", "timestamptz", true), col("last_update", "datetime2(7)", false)];
    expect(suggest("mssql", loose, "dbo.bifast_tx", "table")).toEqual({
      column: "last_update", id: null, idWhy: "No id suggested: bifast_tx has no primary key or unique column. Choose a column that is unique and never empty.",
    });
    expect(suggest("postgres", [col("ref", "text", false)], "core.tx_view", "view").idWhy).toBe("No id suggested: views have no primary key. Choose a column that is unique and never empty.");
    expect(suggest("oracle", [col("LAST_UPDATE", "DATE", false)], "CORE.T", null).column).toBe("LAST_UPDATE");
    expect(suggest("postgres", [col("updated_at", "text", false)], "t", "table").column).toBeNull();
  });
});

describe("list copy (designer's SPEC)", () => {
  const page = (n: number, total: number, more: boolean, capped = false) => ({
    list: "tables" as const, items: Array.from({ length: n }, (_, i) => ({ schema: "core", name: `t${i}`, kind: "table" as const, columns: 1 })), total, totalCapped: capped, next: more ? { schema: "core", name: "x" } : null,
  });
  it("rows, truncation, the live count, empty, no match, gone, failed", () => {
    expect(tableLine({ schema: "core", name: "tx", kind: "view", columns: 18 })).toBe("view · 18 columns");
    expect(tableLine({ schema: "core", name: "tx", kind: "table", columns: 1 })).toBe("table · 1 column");
    expect(truncatedText(page(50, 1284, true))).toBe("Showing 50 of 1,284 tables. Type to narrow the list.");
    expect(truncatedText(page(3, 3, false))).toBeNull();
    expect(shownText(page(50, 10_000, true, true))).toBe("50 of 10,000+ tables shown");
    expect(emptyTables("recon_core")).toBe("This account can't read any tables in recon_core. Ask IT to grant SELECT.");
    expect(noMatch("bfast")).toBe('No table matches "bfast".');
    expect(goneNote("recon_core.bifast_tx")).toBe("recon_core.bifast_tx isn't in the list for this account any more.");
    expect(listFailed("table", "The host could not be reached.")).toBe("The table list couldn't be loaded. The host could not be reached.");
    const refused = "The database list couldn't be loaded: this account can't open the default database postgres (42501). Type the database name instead.";
    expect(listFailed("database", refused)).toBe(refused);
  });
  it("a MySQL table is named alone (its schema is the database); elsewhere schema.table", () => {
    const t = { schema: "core", name: "tx", kind: "table" as const, columns: 2 };
    expect([tableValue("mysql", t), tableValue("postgres", t)]).toEqual(["tx", "core.tx"]);
  });
});

describe("out of date (stale) after a connection change", () => {
  it("engine, host, port, user, password or TLS change the key; the database does not (it is picked from the list)", () => {
    const c = { ...EMPTY_CONN, host: "db", user: "ro", password: "x" };
    expect(credKey({ ...c, database: "other" })).toBe(credKey(c));
    for (const over of [{ host: "db2" }, { port: "5433" }, { user: "ro2" }, { password: "y" }, { tls: false }, { engine: "mysql" as const }]) expect(credKey({ ...c, ...over })).not.toBe(credKey(c));
  });
});

describe("goneFields (PO decision 4)", () => {
  it("fields the new table lacks are kept and marked; those still stored, mapped or in the key block Next", () => {
    const s: SourceSpec = {
      fields: ["id", "updated_at", "sid", "bal", "note"].map((name) => ({ name, type: "string" as const, nullable: true, trim: true })),
      mapping: { business_date: { field: "updated_at" }, account_ref: { field: "sid" }, attrs: { bal: { field: "bal" } } }, derive: {}, key_fields: ["id"], mutable: false, calendar: "id-default",
      input: { kind: "db_watermark", table: "core.bifast_tx_v2", watermark: { column: "updated_at", id_columns: ["id"] }, lookback_seconds: 300, chunk: 5000 },
    };
    const have = [col("id", "bigint", false), col("updated_at", "timestamptz", false)];
    // sid is mapped, bal is stored, note is used by nothing: only sid and bal block
    expect(goneFields(s, have)).toEqual({ gone: ["sid", "bal", "note"], used: ["sid", "bal"] });
    expect(goneFields(s, null)).toEqual({ gone: [], used: [] });
    expect(goneBlocked(2, "core.bifast_tx_v2")).toBe("2 fields refer to columns that bifast_tx_v2 doesn't have.");
    expect(goneBlocked(1, "t")).toBe("1 field refers to columns that t doesn't have.");
  });
});
