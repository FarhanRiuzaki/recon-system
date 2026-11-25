import { describe, expect, it } from "vitest";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { activitySentence, attrNameOf, changes, storeAs, storedName, storedNameProblem, FILE_DATE, fieldError, fieldMessage, fieldsOfColumns, fieldTypeOf, looksLikeHeader, mergeFields, reviewReason, sampleColumns, sampleHead, specDiff } from "./spec-draft";

const spec = (over: Partial<SourceSpec> = {}): SourceSpec => ({
  fields: [{ name: "sid", type: "string", nullable: false, trim: true }, { name: "bal", type: "decimal", nullable: true, trim: true, format: { scale: 2 } }],
  mapping: { business_date: FILE_DATE, account_ref: { field: "sid" }, attrs: { bal: { field: "bal" } } },
  derive: {}, key_fields: ["sid"], mutable: false, calendar: "id-default",
  input: { kind: "file_inbox", path: "/in", pattern: "act*.txt", completion: { kind: "stable_seconds", seconds: 60 }, format: { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" } },
  ...over,
});

describe("sampleColumns", () => {
  it("names col_01 … from the first line without a header, honouring quotes", () => {
    expect(sampleColumns('\n"a|b"|c|d\nx|y|z\n', "|", '"', false)).toEqual(["col_01", "col_02", "col_03"]);
    expect(sampleColumns("a|b", "|", null, false)).toEqual(["col_01", "col_02"]);
    expect(sampleColumns("", "|", '"', false)).toEqual([]);
  });
  it("takes a header's names, trimmed; an empty or repeated one becomes col_NN", () => {
    expect(sampleColumns("﻿sid; sre ;;sid\n1;2;3;4", ";", '"', true)).toEqual(["sid", "sre", "col_03", "col_04"]);
  });
});

describe("sampleHead", () => {
  it("keeps a small sample, cuts a big one at a line end", () => {
    expect(sampleHead("a\nb\n", 10)).toEqual({ text: "a\nb\n", cut: false });
    expect(sampleHead("aaaa\nbbbb\ncccc\n", 12)).toEqual({ text: "aaaa\nbbbb\n", cut: true });
  });
});

describe("fieldTypeOf", () => {
  it("whole numbers, decimals with their scale, dates, timestamps and booleans; the rest text", () => {
    expect(fieldTypeOf("postgres", "bigint")).toEqual({ type: "integer" });
    expect(fieldTypeOf("oracle", "NUMBER(10,0)")).toEqual({ type: "integer" });
    expect(fieldTypeOf("postgres", "numeric(18,2)")).toEqual({ type: "decimal", scale: 2 });
    expect(fieldTypeOf("mssql", "decimal(30, 4)")).toEqual({ type: "decimal", scale: 4 });
    expect(fieldTypeOf("postgres", "date")).toEqual({ type: "date" });
    expect(fieldTypeOf("postgres", "timestamp with time zone")).toEqual({ type: "datetime" });
    expect(fieldTypeOf("mssql", "datetime2")).toEqual({ type: "datetime" });
    expect(fieldTypeOf("mysql", "tinyint")).toEqual({ type: "integer" });
    expect(fieldTypeOf("postgres", "boolean")).toEqual({ type: "boolean" });
    expect(fieldTypeOf("postgres", "text")).toEqual({ type: "string" });
    expect(fieldTypeOf("oracle", "VARCHAR2(40)")).toEqual({ type: "string" });
  });
  it("SQL Server float and real start as text with the scientific-notation hint; elsewhere text without it", () => {
    expect(fieldTypeOf("mssql", "float")).toMatchObject({ type: "string", note: expect.stringContaining("scientific notation") });
    expect(fieldTypeOf("mssql", "real").note).toBeDefined();
    expect(fieldTypeOf("postgres", "double precision")).toEqual({ type: "string" });
  });
});

describe("fieldsOfColumns and mergeFields", () => {
  it("a column becomes a field as detected; empty allowed where the column allows NULL (unknown = allowed)", () => {
    const k = { unique: null, indexed: null };
    expect(fieldsOfColumns("postgres", [{ name: "id", type: "bigint", nullable: false, ...k }, { name: "amt", type: "numeric(18,2)", nullable: true, ...k }, { name: "x", type: "text", nullable: null, ...k }])).toEqual([
      { name: "id", type: "integer", nullable: false, trim: false },
      { name: "amt", type: "decimal", nullable: true, trim: false, format: { scale: 2 } },
      { name: "x", type: "string", nullable: true, trim: true },
    ]);
  });
  it("keeps the user's settings for a column still there, adds a new one, drops one that is gone", () => {
    const kept = [{ name: "a", type: "date" as const, nullable: false, trim: true }, { name: "gone", type: "string" as const, nullable: true, trim: true }];
    const next = [{ name: "b", type: "string" as const, nullable: true, trim: true }, { name: "a", type: "string" as const, nullable: true, trim: true }];
    expect(mergeFields(kept, next)).toEqual([next[0], kept[0]]);
  });
});

describe("fieldError", () => {
  it("reads the field the API names, for a refine and for a CEL expression", () => {
    expect(fieldError("Check mapping.amount_minor: The amount needs an integer.")).toEqual({ path: "mapping.amount_minor", reason: "The amount needs an integer." });
    expect(fieldError("Check the expression at derive.net: Can't parse it: x")).toEqual({ path: "derive.net", reason: "Can't parse it: x" });
    expect(fieldError("Check fields.3.format.timezone: Unknown time zone.")?.path).toBe("fields.3.format.timezone");
    expect(fieldError("Check currency: Map the currency column, or set the currency of every row.")?.path).toBe("currency");
    expect(fieldError("There is no calendar x.")).toBeNull();
  });
});

describe("specDiff", () => {
  it("one row per field, mapping or setting that changed; nothing for what stayed", () => {
    const after = spec({
      fields: [{ name: "sid", type: "string", nullable: false, trim: true }, { name: "bal", type: "decimal", nullable: true, trim: true, format: { scale: 4 } }, { name: "on", type: "date", nullable: true, trim: true, format: { date: "yyyyMMdd" } }],
      key_fields: ["sid", "on"],
    });
    expect(specDiff(spec(), after)).toEqual([
      { key: "field:bal", label: "bal", before: "Decimal, 2 places", after: "Decimal, 4 places" },
      { key: "field:on", label: "on", before: null, after: "Date, format yyyyMMdd" },
      { key: "key_fields", label: "Match key", before: "sid", after: "sid, on" },
    ]);
    expect(specDiff(spec(), spec())).toEqual([]);
  });
  it("an amount unit change and a fixed currency are rows of their own", () => {
    const amt = { name: "amt", type: "integer" as const, nullable: true, trim: true };
    const before = spec({ fields: [...spec().fields, amt], mapping: { ...spec().mapping, amount_minor: { field: "amt" } } }); // no unit: an integer is minor
    const after = { ...before, currency: "IDR", mapping: { ...before.mapping, amount_minor: { field: "amt", unit: "major" as const } } };
    expect(specDiff(before, after).filter((r) => r.key === "mapping:amount_unit" || r.key === "currency")).toEqual([
      { key: "mapping:amount_unit", label: "Amount unit", before: "Minor units", after: "Currency units" },
      { key: "currency", label: "Currency for every row", before: null, after: "IDR" },
    ]);
  });
  it("against no published version every part is new", () => {
    const rows = specDiff(null, spec());
    expect(rows.find((r) => r.key === "mapping:business_date")).toEqual({ key: "mapping:business_date", label: "Business date", before: null, after: "the file name's date" });
    expect(rows.find((r) => r.key === "input:completion")?.after).toBe("Size unchanged for 60 s");
  });
  it("rows to load, when to read and the look back are rows in words, not raw values", () => {
    const keep = spec({ keep: [{ field: "sid", op: "ne", value: "X" }] });
    expect(specDiff(spec(), keep)).toEqual([{ key: "keep", label: "Rows to load", before: "Every row", after: "sid is not X" }]);
    const file = spec().input as Extract<SourceSpec["input"], { kind: "file_inbox" }>;
    expect(specDiff(spec(), spec({ input: { ...file, when: { every_minutes: 15, hours: { from: 6, to: 22 } } } }))).toEqual([
      { key: "input:when", label: "When to read", before: "Every minute", after: "Every 15 minutes, 06:00–22:00" },
    ]);
    const wm = (o: object) => spec({ fields: [{ name: "u", type: "date", nullable: false, trim: false }], input: { kind: "db_watermark", table: "t", watermark: { column: "u", id_columns: ["u"] }, chunk: 100, ...o } });
    expect(specDiff(wm({}), wm({ lookback_seconds: 172_800 })).filter((r) => r.key.startsWith("input:"))).toEqual([
      { key: "input:lookback", label: "Look back", before: "1 day (default)", after: "2 days" },
    ]);
    // Oracle's DATE holds a time: no day by default
    expect(specDiff(wm({}), wm({ lookback_seconds: 60 }), "oracle").find((r) => r.key === "input:lookback")?.before).toBe("None (default)");
  });
});

describe("reviewReason", () => {
  const v = { status: "in_review", submitterId: "s", makerId: "m", contributorIds: ["m", "c", "s"] };
  it("says who may act, in the designer's order: not waiting, submitted, worked on it, no checker role", () => {
    expect(reviewReason({ ...v, status: "published" }, "x", true, "approve")).toBe("This version is no longer waiting for approval.");
    expect(reviewReason(v, "s", true, "approve")).toBe("You submitted this version. Another config checker approves it.");
    expect(reviewReason(v, "s", false, "reject")).toBe("You submitted this version. Another config checker rejects it.");
    expect(reviewReason(v, "c", true, "approve")).toBe("You worked on this version. A config checker who didn't work on it approves it.");
    expect(reviewReason(v, "m", true, "reject")).toBe("You worked on this version. A config checker who didn't work on it rejects it.");
    expect(reviewReason(v, "x", false, "approve")).toBe("Only a config checker of this space approves source versions.");
    expect(reviewReason(v, "x", true, "approve")).toBeNull();
  });
});

describe("looksLikeHeader", () => {
  it("a first line of names over a line with numbers; not a data line, not an all-text file", () => {
    expect(looksLikeHeader("ref|amount|value_date\nR1|100.50|20261102\n", "|", '"')).toBe(true);
    expect(looksLikeHeader("R1|100.50|20261102\nR2|7|20261103\n", "|", '"')).toBe(false);
    expect(looksLikeHeader("ACT|KSEI|SRE\nACT|KSEI|SRE2\n", "|", '"')).toBe(false);
    expect(looksLikeHeader("ref|amount\n", "|", '"')).toBe(false);
  });
});

describe("activitySentence", () => {
  const e = (action: string, after: unknown = null, before: unknown = null) => ({ action, actor: { name: "Ayu" }, before, after });
  it("one sentence per event: who did what to which version; never a hash", () => {
    expect(activitySentence(e("source.create", { code: "x" }))).toBe("Ayu created the source.");
    expect(activitySentence(e("source.connection_set", { engine: "postgres" }))).toBe("Ayu set the connection.");
    expect(activitySentence(e("source.connection_set", { engine: "postgres" }, { engine: "mysql" }))).toBe("Ayu replaced the connection.");
    expect(activitySentence(e("source.connection_set", { engine: "postgres", tlsOff: { host: "core-db.bank.internal" } }))).toBe("Ayu set the connection. TLS turned off for core-db.bank.internal.");
    expect(activitySentence(e("source.version_create", { version: 2, from: 1 }))).toBe("Ayu started version 2 from version 1.");
    expect(activitySentence(e("source.version_update", { version: 2, specHash: "58bc7319" }))).toBe("Ayu edited version 2.");
    expect(activitySentence(e("source.version_submit", { version: 2, specHash: "58bc" }))).toBe("Ayu submitted version 2.");
    expect(activitySentence(e("source.version_approve", { version: 2, retired: 1 }))).toBe("Ayu approved version 2; version 1 retired.");
    expect(activitySentence(e("source.version_reject", { version: 2, comment: "Name col_03" }))).toBe("Ayu sent version 2 back: \u201cName col_03\u201d");
    expect(activitySentence(e("source.share", { space: { name: "CTOP" } }))).toBe("Ayu shared the source with CTOP.");
  });
  it("counts changes in words", () => {
    expect([changes(1), changes(3)]).toEqual(["1 change", "3 changes"]);
  });
});

describe("stored names (fix round 2)", () => {
  it("a column starts stored under its own name, as an identifier", () => {
    expect(attrNameOf("col_13")).toBe("col_13");
    expect(attrNameOf("REFERENCE_NO")).toBe("reference_no");
    expect(attrNameOf("Value Date")).toBe("value_date");
    expect(attrNameOf("1st")).toBe("c_1st");
  });
  it("renames, stops and restarts storing a column; the other names keep their place", () => {
    const s = spec();
    expect(storedName(s, "bal")).toBe("bal");
    const renamed = storeAs(s, "bal", "balance");
    expect(Object.keys(renamed.mapping.attrs)).toEqual(["balance"]);
    expect(storedName(renamed, "bal")).toBe("balance");
    const off = storeAs(renamed, "bal", null);
    expect(off.mapping.attrs).toEqual({});
    expect(storeAs(off, "sid", "sid").mapping.attrs).toEqual({ sid: { field: "sid" } });
  });
  it("a name must be an identifier, and no other column's", () => {
    const s = storeAs(spec(), "sid", "sid");
    expect(storedNameProblem("Sid", "bal", s)).toBe("Use a-z, 0-9 and _, starting with a letter, up to 63 characters.");
    expect(storedNameProblem("sid", "bal", s)).toBe("Another column is stored as sid. Use a different name.");
    expect(storedNameProblem("sid", "sid", s)).toBeNull();
    expect(storedNameProblem("balance", "bal", s)).toBeNull();
  });
});

describe("fieldMessage (a refused spec in words)", () => {
  it("says which setting a short reason is about; a written reason stands", () => {
    expect(fieldMessage({ path: "input.watermark.column", reason: "Required." })).toBe("Watermark column: required.");
    expect(fieldMessage({ path: "fields.1.type", reason: "Pick one of string, integer." }, [{ name: "a", type: "string", nullable: false, trim: true }, { name: "amt", type: "string", nullable: false, trim: true }]))
      .toBe("amt, type: pick one of string, integer.");
    expect(fieldMessage({ path: "keep.0.value", reason: "Required." })).toBe("Condition 1: required.");
    expect(fieldMessage({ path: "mapping.amount_minor", reason: "The amount needs an integer." })).toBe("The amount needs an integer.");
  });
});

describe("customer-data marks follow their attribute", () => {
  const base = { fields: [{ name: "nik", type: "string", nullable: true, trim: true }], mapping: { business_date: { cel: "file_date" }, attrs: { nik: { field: "nik" } }, customer: ["nik"] } } as unknown as SourceSpec;
  it("a rename carries the mark; no longer stored drops it", () => {
    expect(storeAs(base, "nik", "id_number").mapping.customer).toEqual(["id_number"]);
    expect(storeAs(base, "nik", null).mapping.customer).toEqual([]);
  });
});
