import { describe, expect, it } from "vitest";
import { applySteps, computeCel, computeSteps, jsonPaths } from "./compute";

const doc = JSON.stringify({ e2e_id: "E2E-1", payment: { ref: "INV-42", amount: 1500 }, items: [{ id: "A1" }, { id: "B2" }], "odd key": "x", n: null });
const json = (s: string, path: string) => applySteps(s, [{ type: "json", args: [path] }]);

describe("JSON step and paths (a JSON column in a mapping or a computed column)", () => {
  it("reads a value by path; missing, null, broken or oversized JSON is empty", () => {
    expect([json(doc, "e2e_id"), json(doc, "payment.ref"), json(doc, "payment.amount"), json(doc, "items[1].id"), json(doc, '["odd key"]')])
      .toEqual(["E2E-1", "INV-42", "1500", "B2", "x"]);
    expect(json(doc, "payment")).toBe('{"ref":"INV-42","amount":1500}');
    expect([json(doc, "nope.x"), json(doc, "n"), json(doc, "items[9].id"), json("{broken", "a"), json(`{"a":"${"x".repeat(70_000)}"}`, "a")]).toEqual(["", "", "", "", ""]);
  });
  it("lists every plain value's path, each reading back its example; a list at its first item; none for text", () => {
    const paths = jsonPaths([doc]);
    expect(paths.map((p) => p.path)).toEqual(["e2e_id", "payment.ref", "payment.amount", "items[0].id", '["odd key"]']);
    for (const p of paths) expect(json(doc, p.path)).toBe(p.example);
    expect(jsonPaths(["TRF INV-1", "", "42"])).toEqual([]);
  });
  it("JSON in JSON in JSON: nested objects and JSON text inside a value", () => {
    const nested = JSON.stringify({ data: { code: { rc: 20 } } });
    expect(json(nested, "data.code.rc")).toBe("20");
    const inText = JSON.stringify({ data: JSON.stringify({ code: JSON.stringify({ rc: 20 }) }) });
    expect(json(inText, "data.code.rc")).toBe("20");
    expect(jsonPaths([inText])).toEqual([{ path: "data.code.rc", example: "20" }]);
  });
  it("a mapping kept as an expression reads back as the column and path", () => {
    const cel = computeCel("payload", [{ type: "json", args: ["payment.ref"] }]);
    expect(computeSteps(cel)).toEqual({ source: "payload", steps: [{ type: "json", args: ["payment.ref"] }] });
  });
});
