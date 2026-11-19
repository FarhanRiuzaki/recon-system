import { describe, expect, it } from "vitest";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { FILE_DATE, fieldError, fieldsOfColumns, fieldTypeOf, mergeFields, reviewReason, sampleColumns, sampleHead, specDiff } from "./spec-draft";

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
    expect(fieldsOfColumns("postgres", [{ name: "id", type: "bigint", nullable: false }, { name: "amt", type: "numeric(18,2)", nullable: true }, { name: "x", type: "text", nullable: null }])).toEqual([
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
  it("against no published version every part is new", () => {
    const rows = specDiff(null, spec());
    expect(rows.find((r) => r.key === "mapping:business_date")).toEqual({ key: "mapping:business_date", label: "business_date", before: null, after: "the file name's date" });
    expect(rows.find((r) => r.key === "input:completion")?.after).toBe("Size unchanged for 60 s");
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
