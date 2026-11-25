// The file reader (read.ts): every text kind through one iterator, skips, record types, encodings.
import { describe, expect, it } from "bun:test";
import type { FileFormat } from "@starterkit/shared/contracts/sources";
import { type ParsedLine, parseText } from "../../parse";
import { readRows, readText } from "../../read";

const DELIM = { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" } as const;
const bytes = (s: string | Uint8Array) => (async function* () { yield typeof s === "string" ? new TextEncoder().encode(s) : s; })();
const all = async (it: AsyncIterable<ParsedLine>) => { const out: ParsedLine[] = []; for await (const l of it) out.push(l); return out; };
const okRows = (ls: ParsedLine[]) => ls.filter((l) => l.ok).map((l) => (l as Extract<ParsedLine, { ok: true }>).raw);
const bad = (ls: ParsedLine[]) => ls.filter((l) => !l.ok).map((l) => Object.values((l as Extract<ParsedLine, { ok: false }>).reasons)[0]);

describe("an old delimited format", () => {
  it("reads exactly as the delimited parser does", async () => {
    const text = 'A1|B1|"x|y"\nA2|B2|c\nA3|B3\n';
    expect(await readText(text, DELIM, ["a", "b", "c"])).toEqual(await parseText(text, DELIM, ["a", "b", "c"]));
  });
});

describe("skips", () => {
  it("title rows above the header are dropped and the header names are checked", async () => {
    const ls = await readText("Report\nDate x\nA|B\n1|2\n", { ...DELIM, header: true, skip_top: 2 }, ["A", "B"]);
    expect(okRows(ls)).toEqual([{ A: "1", B: "2" }]);
    expect(bad(ls)).toEqual([]);
  });

  it("a title row with a quote it never closes is skipped as text, not read as a value that runs to the end", async () => {
    const ls = await readText('"Report of 25 Nov\nA|B\n1|2\n3|"x"\n', { ...DELIM, header: true, skip_top: 1 }, ["A", "B"]);
    expect(okRows(ls)).toEqual([{ A: "1", B: "2" }, { A: "3", B: "x" }]);
    expect(bad(ls)).toEqual([]);
    expect(ls.map((l) => l.line)).toEqual([3, 4]);
  });

  it("rows at the end are counted as records: a quoted line break doesn't shift them", async () => {
    const ls = await readText('a|"x\ny"\nTOTAL|9\n', { ...DELIM, skip_bottom: 1 }, ["k", "v"]);
    expect(okRows(ls)).toEqual([{ k: "a", v: "x\ny" }]);
  });
});

describe("fixed length", () => {
  const FIXED: FileFormat = { kind: "fixed_width", encoding: "utf-8", header: false, columns: [{ start: 1, length: 3 }, { start: 4, length: 5 }] };
  it("cuts each line at the positions, keeping the raw text", async () => {
    expect(okRows(await readText("ABC12345\r\nDEF  678\n", FIXED, ["ref", "amt"]))).toEqual([{ ref: "ABC", amt: "12345" }, { ref: "DEF", amt: "  678" }]);
  });
});

describe("record types", () => {
  const types = [{ code: "H", role: "header", count: 3 }, { code: "D", role: "detail", count: 3 }, { code: "T", role: "skip", count: 2 }] as const;
  const RT: FileFormat = { ...DELIM, records: { marker: { kind: "column", index: 0 }, types: [...types] } };
  const cols = ["hdr_01", "hdr_02", "hdr_03", "col_01", "col_02", "col_03"];
  it("each detail carries the header above it; a detail before any header gets empty header columns; the trailer is skipped", async () => {
    const ls = await readText("D|X|1\nH|M1|20261125\nD|T1|100\nD|T2|200\nT|2\n", RT, cols);
    expect(okRows(ls).map((r) => cols.map((c) => r[c]))).toEqual([
      ["", "", "", "D", "X", "1"], ["H", "M1", "20261125", "D", "T1", "100"], ["H", "M1", "20261125", "D", "T2", "200"],
    ]);
  });
  it("an unknown type and a wrong cell count are quarantined with their reason", async () => {
    expect(bad(await readText("H|M|1\nQ|z|z\nD|T3\n", RT, cols))).toEqual(["Unknown record type Q", "Expected 3 columns for record type D, got 2"]);
  });
  it("fixed length: the marker is the line's first characters, each type has its own positions", async () => {
    const F: FileFormat = { kind: "fixed_width", encoding: "utf-8", header: false, columns: [{ start: 1, length: 1 }], records: { marker: { kind: "prefix", length: 1 },
      types: [{ code: "H", role: "header", count: 2, columns: [{ start: 1, length: 1 }, { start: 2, length: 4 }] }, { code: "D", role: "detail", count: 2, columns: [{ start: 1, length: 1 }, { start: 2, length: 3 }] }] } };
    const ls = await readText("HABCD\nD123\nD456\n", F, ["hdr_01", "hdr_02", "col_01", "col_02"]);
    expect(okRows(ls).map((r) => [r.hdr_02, r.col_02])).toEqual([["ABCD", "123"], ["ABCD", "456"]]);
  });
});

describe("encodings", () => {
  it("windows-1252 with CRLF: é read right, no stray carriage return", async () => {
    const b = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x7c, 0x31, 0x0d, 0x0a]);
    expect(okRows(await all(readRows(bytes(b), { ...DELIM, encoding: "windows-1252" }, ["a", "b"])))).toEqual([{ a: "café", b: "1" }]);
  });
  it("a UTF-16 byte order mark wins over the declared encoding", async () => {
    const s = "a|b\n";
    const b = new Uint8Array([0xff, 0xfe, ...[...s].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(okRows(await all(readRows(bytes(b), DELIM, ["x", "y"])))).toEqual([{ x: "a", y: "b" }]);
  });
});

describe("review 25 Nov", () => {
  it("skip_bottom never hides a fault of the whole file: an unclosed quote still fails it", async () => {
    const ls = await readText('a|b\nc|"open\nd|e\n', { ...DELIM, skip_bottom: 1 }, ["x", "y"]);
    expect(ls.some((l) => !l.ok && l.fatal === "file")).toBe(true);
  });
  it("a fixed-length file without line feeds stops at the line limit as a fault of the whole file", async () => {
    const F: FileFormat = { kind: "fixed_width", encoding: "utf-8", header: false, columns: [{ start: 1, length: 3 }] };
    const big = "ABC\r".repeat(400_000);
    const ls = await all(readRows(bytes(big), F, ["a"]));
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ ok: false, fatal: "file" });
  });
});
