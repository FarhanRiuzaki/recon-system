import { describe, expect, it } from "bun:test";
import { compileDerive, runDerive } from "../../cel";

const ok = (expr: string) => {
  const c = compileDerive(expr);
  if ("error" in c) throw new Error(c.error);
  return c;
};
const vars = (row: Record<string, string>) => ({ row, file_name: "act20261102.txt", file_date: "2026-11-02" });

describe("compileDerive", () => {
  it("rejects matches(), macros, other functions, long and deep expressions", () => {
    expect(compileDerive('row.a.matches("a+")')).toEqual({ error: expect.stringContaining("matches") });
    for (const e of ["[1].all(x, x > 0)", "[1].map(x, x * 2)", 'bytes("a")', 'timestamp("2026-01-01T00:00:00Z")'])
      expect(compileDerive(e)).toEqual({ error: expect.stringContaining("not allowed") });
    expect(compileDerive("1+".repeat(600) + "1")).toEqual({ error: expect.stringContaining("longer than") });
    expect(compileDerive("(".repeat(30) + "1" + ")".repeat(30))).toEqual({ error: expect.stringContaining("parse") });
    expect(compileDerive("row.a +")).toEqual({ error: expect.stringContaining("parse") });
    expect(compileDerive('1 + "x"')).toEqual({ error: expect.stringContaining("Type error") });
  });

  it("re_match takes only a whitelisted pattern id, written as a literal", () => {
    expect(compileDerive('re_match(row.a, "nope")')).toEqual({ error: expect.stringContaining("nope") });
    expect(compileDerive("re_match(row.a, row.b)")).toEqual({ error: expect.stringContaining("literal") });
    const c = ok('re_match(row.a, "digits_only")');
    expect(runDerive(c, vars({ a: "123" }))).toEqual({ ok: true, value: true });
    expect(runDerive(c, vars({ a: "12x" }))).toEqual({ ok: true, value: false });
    expect(runDerive(ok('re_match(row.d, "iso_date")'), vars({ d: "2026-11-02" }))).toEqual({ ok: true, value: true });
    expect(runDerive(ok('re_match(row.d, "alnum")'), vars({ d: "ab12" }))).toEqual({ ok: true, value: true });
  });

  it("evaluates over row, file_name and file_date; results are plain JS values", () => {
    expect(runDerive(ok('row.a.trim() + "-" + row.b'), vars({ a: " x ", b: "y" }))).toEqual({ ok: true, value: "x-y" });
    expect(runDerive(ok("file_date"), vars({}))).toEqual({ ok: true, value: "2026-11-02" });
    expect(runDerive(ok("int(row.n) * 100"), vars({ n: "12345" }))).toEqual({ ok: true, value: 1234500n });
  });

  it("a runtime failure is a reason, not a throw", () => {
    const r = runDerive(ok("int(row.n)"), vars({ n: "abc" }));
    expect(r.ok).toBe(false);
  });
});
