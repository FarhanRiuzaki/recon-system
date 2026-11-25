import { describe, expect, it } from "vitest";
import { ROLE_LABEL, summaryOf, toggleBoundary } from "./file-read-model";

describe("summaryOf", () => {
  it("says how the file is read in one line", () => {
    expect(summaryOf({ kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8", skip_bottom: 1 }, "act20261125.txt"))
      .toBe("act20261125.txt · Delimited · Pipe | · UTF-8 · No header · 1 row skipped at the end");
    expect(summaryOf({ kind: "excel", sheet: { kind: "name", name: "ACT 25-11" }, header: true, skip_top: 1 }, "report.xlsx"))
      .toBe("report.xlsx · Excel · Sheet ACT 25-11 · Header on row 2");
    expect(summaryOf({ kind: "fixed_width", encoding: "windows-1252", header: false, columns: [{ start: 1, length: 4 }, { start: 5, length: 6 }] }, "bank.dat"))
      .toBe("bank.dat · Fixed length · 2 columns · WINDOWS-1252 · No header");
    expect(summaryOf({ kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8", records: { marker: { kind: "column", index: 0 }, types: [
      { code: "H", role: "header", count: 3 }, { code: "D", role: "detail", count: 3 }, { code: "T", role: "skip", count: 2 }] } }, "hd.txt"))
      .toBe("hd.txt · Delimited · Pipe | · UTF-8 · Header lines H, detail lines D, skipped T");
  });
});

describe("toggleBoundary", () => {
  it("adds a column start inside a column, and removes it again (merging the two)", () => {
    const one = [{ start: 1, length: 8 }];
    const two = toggleBoundary(one, 4);
    expect(two).toEqual([{ start: 1, length: 3 }, { start: 4, length: 5 }]);
    expect(toggleBoundary(two, 4)).toEqual(one);
    expect(toggleBoundary(one, 1)).toEqual(one); // the first column's start stays
  });
});

describe("ROLE_LABEL", () => {
  it("names each row role", () => {
    expect(ROLE_LABEL).toEqual({ skipped: "Skipped", header: "Header", detail: "Row", record_header: "Record header", trailer: "Trailer", quarantined: "Can't be read" });
  });
});
