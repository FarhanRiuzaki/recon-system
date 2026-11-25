import { describe, expect, it } from "vitest";
import { FileFormat, PreviewSourceBody } from "./sources";

const OLD = { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" } as const;

describe("FileFormat", () => {
  it("an old delimited format parses without any new key written (its spec hash stays the same)", () => {
    const f = FileFormat.parse(OLD);
    expect(f).toEqual(OLD);
    expect(Object.keys(f).sort()).toEqual(["delimiter", "encoding", "header", "kind", "quote"]);
  });

  it("takes skips on delimited, fixed-length columns and an Excel sheet by pattern", () => {
    expect(FileFormat.parse({ ...OLD, skip_top: 3, skip_bottom: 1 })).toMatchObject({ skip_top: 3, skip_bottom: 1 });
    expect(FileFormat.parse({ kind: "fixed_width", encoding: "utf-8", header: false, columns: [{ start: 1, length: 3 }, { start: 4, length: 5 }] }).kind).toBe("fixed_width");
    expect(FileFormat.parse({ kind: "excel", sheet: { kind: "pattern", pattern: "ACT*" }, header: true }).kind).toBe("excel");
  });

  it("record types: exactly one detail, at most one header, positions only on fixed-length", () => {
    const types = [{ code: "H", role: "header", count: 3 }, { code: "D", role: "detail", count: 3 }, { code: "T", role: "skip", count: 2 }];
    expect(FileFormat.parse({ ...OLD, records: { marker: { kind: "column", index: 0 }, types } }).kind).toBe("delimited");
    expect(FileFormat.safeParse({ ...OLD, records: { marker: { kind: "column", index: 0 }, types: [...types, { code: "E", role: "detail", count: 2 }] } }).success).toBe(false);
    expect(FileFormat.safeParse({ ...OLD, records: { marker: { kind: "column", index: 0 }, types: [{ code: "H", role: "header", count: 2 }, { code: "G", role: "header", count: 2 }, { code: "D", role: "detail", count: 2 }] } }).success).toBe(false);
    expect(FileFormat.safeParse({ ...OLD, records: { marker: { kind: "column", index: 0 }, types: [{ code: "D", role: "detail", count: 1, columns: [{ start: 1, length: 2 }] }, { code: "T", role: "skip", count: 1 }] } }).success).toBe(false);
    const fixed = { kind: "fixed_width", encoding: "utf-8", header: false, columns: [{ start: 1, length: 1 }] };
    expect(FileFormat.safeParse({ ...fixed, records: { marker: { kind: "prefix", length: 1 }, types: [{ code: "D", role: "detail", count: 2, columns: [{ start: 1, length: 1 }, { start: 2, length: 5 }] }, { code: "T", role: "skip", count: 1, columns: [{ start: 1, length: 1 }] }] } }).success).toBe(true);
    expect(FileFormat.safeParse({ ...fixed, records: { marker: { kind: "prefix", length: 1 }, types: [{ code: "D", role: "detail", count: 2 }, { code: "T", role: "skip", count: 1 }] } }).success).toBe(false);
  });
});

describe("PreviewSourceBody", () => {
  it("takes a sample by its id", () => {
    expect(PreviewSourceBody.safeParse({ sampleId: "01a2110e-f37b-76e0-88c5-42b0cb60b842" }).success).toBe(true);
  });
});
