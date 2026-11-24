import { describe, expect, it } from "vitest";
import type { ResultColumn } from "@starterkit/shared/contracts/results";
import type { RecordField } from "@starterkit/shared/recon";
import { addColumn, columnChoices } from "./result-columns-model";

const f = (kind: RecordField["kind"], from: string | null = null): RecordField => ({ kind, from, fromType: null });
const sides = [
  { label: "Core banking", fields: new Map([["ext_ref", f("text", "trx_id")], ["amount_minor", f("decimal")], ["attrs.merchant_id", f("text", "MID")]]) },
  { label: "BI-FAST", fields: new Map([["ext_ref", f("text")], ["attrs.channel", f("text")]]) },
] as const;
const ref: ResultColumn = { kind: "a", field: "ext_ref", label: "Core banking reference" };

describe("column choices", () => {
  it("each side's fields under the side's name, core fields by their label, stored ones by their name; then recon info", () => {
    const c = columnChoices(sides);
    expect(c.filter((x) => x.group === "Core banking").map((x) => [x.value, x.label])).toEqual([["a:ext_ref", "Reference"], ["a:amount_minor", "Amount"], ["a:attrs.merchant_id", "merchant_id"]]);
    expect(c.filter((x) => x.group === "BI-FAST").map((x) => x.label)).toEqual(["Reference", "channel"]);
    expect(c.filter((x) => x.group === "Recon").map((x) => x.label)).toContain("Unmatch reason");
  });
  it("a side whose source isn't read yet offers nothing for it", () => {
    expect(columnChoices([{ label: "A", fields: null }, sides[1]]).some((x) => x.group === "A")).toBe(false);
  });
});

describe("adding and moving columns", () => {
  it("a pick becomes a column headed by its side and label", () => {
    expect(addColumn([], "b:attrs.channel", sides)).toEqual({ columns: [{ kind: "b", field: "attrs.channel", label: "BI-FAST channel" }] });
    expect(addColumn([], "recon:reason", sides)).toEqual({ columns: [{ kind: "recon", field: "reason", label: "Unmatch reason" }] });
  });
  it("a duplicate pick is refused", () => {
    expect(addColumn([ref], "a:ext_ref", sides)).toEqual({ error: "Already a column" });
  });
  it("a 21st column is refused", () => {
    const twenty = Array.from({ length: 20 }, (_, i): ResultColumn => ({ kind: "a", field: `attrs.f${i}`, label: `F${i}` }));
    expect(addColumn(twenty, "recon:pass", sides)).toEqual({ error: "At most 20 columns" });
  });
});
