import { describe, expect, it } from "vitest";
import type { OperationSpec } from "@starterkit/shared/contracts/integrations";
import { prune, renamePath, replaceAt } from "./connector-model";

const op: OperationSpec = {
  key: "post", name: "Post", method: "POST", path: "/", timeoutMs: 30000,
  request: [{ name: "Currency", type: "string", required: false }, { name: "DE48", type: "object", required: false, children: [{ name: "Cur", type: "string", required: false }] }],
  response: [{ name: "ResponseCode", type: "string", required: false }, { name: "Ref", type: "string", required: false }],
  success: { field: "ResponseCode", equals: "00" }, reference: "Ref", masked: ["DE48.Cur", "Ref"], presets: { Currency: "IDR", "DE48.Cur": "IDR" },
};

describe("a connector's draft (final review I2, I3)", () => {
  it("renaming a field moves its fixed value, mask, success rule and reference with it, children included", () => {
    const r = renamePath(op, "DE48", "DE49");
    expect(r.presets).toEqual({ Currency: "IDR", "DE49.Cur": "IDR" });
    expect(r.masked).toEqual(["DE49.Cur", "Ref"]);
    const s = renamePath(op, "ResponseCode", "RC");
    expect([s.success?.field, renamePath(op, "Ref", "BankRef").reference]).toEqual(["RC", "BankRef"]);
  });
  it("saving drops what points to a field that is gone, so the draft still saves", () => {
    const gone = prune({ ...op, request: [op.request[0]!], response: [op.response[0]!] });
    expect([gone.presets, gone.masked, gone.reference, gone.success?.field]).toEqual([{ Currency: "IDR" }, [], null, "ResponseCode"]);
    expect(prune({ ...op, response: [] }).success).toBeNull();
  });
  it("an operation is replaced by its place, never by its key, so two with the same key stay two", () => {
    const a = { ...op, key: "same" }, b = { ...op, key: "same", name: "Second" };
    expect(replaceAt([a, b], 1, { ...b, name: "Edited" }).map((o) => o.name)).toEqual(["Post", "Edited"]);
  });
});
