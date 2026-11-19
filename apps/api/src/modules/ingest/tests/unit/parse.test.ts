import { describe, expect, it } from "bun:test";
import { parseDelimited, parseText, type ParsedLine } from "../../parse";
import { KSEI_FILE, ksei } from "./fixtures";

const fmt = { delimiter: "|", header: false, encoding: "utf-8" as const };

describe("parseText", () => {
  it("the KSEI fixture: 12 lines, the 13-column one is quarantined with its count", async () => {
    const lines = await parseText(KSEI_FILE, fmt, ksei().fields.map((x) => x.name));
    expect(lines).toHaveLength(12);
    const bad = lines.filter((l) => !l.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ line: 11, reasons: { _row: "Expected 14 columns, got 13" } });
    const first = lines[0] as Extract<ParsedLine, { ok: true }>;
    expect(first.line).toBe(1);
    expect(first.raw.sid).toBe("TSTSID000000001");
    expect(first.raw.sre).toBe("TSTSRE001");
  });
  it("header skipped, quotes, CRLF, BOM, blank lines", async () => {
    const lines = await parseText('﻿a,b\r\n"x,1","he said ""hi"""\r\n\r\ny,2\r\n', { delimiter: ",", header: true, encoding: "utf-8" }, ["a", "b"]);
    expect(lines.map((l) => (l.ok ? l.raw : null))).toEqual([{ a: "x,1", b: 'he said "hi"' }, { a: "y", b: "2" }]);
    expect(lines.map((l) => l.line)).toEqual([2, 4]);
  });
  it("a stray quote quarantines from where it opened, with the raw text and a sentence-case reason; lines before it stay in order", async () => {
    const lines = await parseText('a|b\n"x|1\ny|2\nz|3\n', { delimiter: "|", header: false, encoding: "utf-8" }, ["a", "b"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line: 1, ok: true, raw: { a: "a", b: "b" } });
    expect(lines[1]).toMatchObject({ line: 2, ok: false });
    const bad = lines[1] as Extract<ParsedLine, { ok: false }>;
    expect(bad.cells.join("")).toContain('"x|1');
    expect(bad.reasons._row).toMatch(/^Quote not closed/);
  });
  it("quote: null reads quotes as plain text (KSEI pipe files)", async () => {
    const lines = await parseText('a|"b\nc|d\n', { delimiter: "|", header: false, encoding: "utf-8", quote: null }, ["a", "b"]);
    expect(lines.map((l) => (l.ok ? l.raw : null))).toEqual([{ a: "a", b: '"b' }, { a: "c", b: "d" }]);
  });
  it("a line over 1 MB is quarantined, not buffered without end", async () => {
    const lines = await parseText(`a|"${"x".repeat(2_000_000)}\nz|3\n`, { delimiter: "|", header: false, encoding: "utf-8" }, ["a", "b"]);
    expect(lines.some((l) => !l.ok)).toBe(true);
  });
});

describe("parseDelimited (stream)", () => {
  it("decodes the declared encoding across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("é|ü\nz|y\n");
    const chunks = [bytes.slice(0, 1), bytes.slice(1, 4), bytes.slice(4)]; // splits the 2-byte "é"
    const stream = new ReadableStream<Uint8Array>({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
    const out: ParsedLine[] = [];
    for await (const l of parseDelimited(stream, fmt, ["a", "b"])) out.push(l);
    expect(out.map((l) => (l.ok ? l.raw : null))).toEqual([{ a: "é", b: "ü" }, { a: "z", b: "y" }]);
  });
  const chunk = new TextEncoder().encode("x|y\n".repeat(20000));
  const within = <T,>(p: Promise<T>, ms = 1500) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("hung")), ms))]);
  it("returns promptly when the consumer stops early, and stops pulling the source", async () => {
    let pulls = 0;
    const src = new ReadableStream<Uint8Array>({ pull(c) { if (++pulls > 50) c.close(); else c.enqueue(chunk); } });
    let n = 0;
    await within((async () => { for await (const _ of parseDelimited(src, fmt, ["a", "b"])) if (++n === 10) break; })());
    const at = pulls;
    await new Promise((r) => setTimeout(r, 50));
    expect(pulls).toBeLessThanOrEqual(at + 1);
    expect(pulls).toBeLessThan(50);
  });
  it("a consumer that throws gets its error promptly", async () => {
    const src = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 50; i++) c.enqueue(chunk); c.close(); } });
    const run = (async () => { for await (const _ of parseDelimited(src, fmt, ["a", "b"])) throw new Error("db insert failed"); })();
    await expect(within(run)).rejects.toThrow("db insert failed");
  });
  it("yields to the event loop while a big file streams (heartbeat, S2)", async () => {
    const row = `${"x".repeat(20)}|${"y".repeat(20)}\n`;
    const total = 60_000;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { const enc = new TextEncoder(); for (let i = 0; i < total; i += 1000) c.enqueue(enc.encode(row.repeat(1000))); c.close(); },
    });
    let ticks = 0, n = 0, maxGap = 0, last = performance.now(), stop = false;
    const timer = setInterval(() => ticks++, 1);
    const spin = (async () => { while (!stop) { await new Promise((r) => setImmediate(r)); const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; } })();
    for await (const l of parseDelimited(stream, fmt, ["a", "b"], { yieldEvery: 1000 })) if (l.ok) n++;
    stop = true;
    await spin;
    clearInterval(timer);
    expect(n).toBe(total);
    expect(maxGap).toBeLessThan(300); // a macrotask turn at least every 300 ms: pg-boss heartbeat is 30 s
  });
});
