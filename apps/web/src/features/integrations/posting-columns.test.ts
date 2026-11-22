import { describe, expect, it } from "vitest";
import { postingColumns } from "./posting-page";

describe("posting result columns (audit §5.3)", () => {
  it("seven shown at 1440; attempt and recon start hidden", () => {
    const cols = postingColumns("sp-1");
    expect(cols.filter((c) => !c.defaultHidden).map((c) => c.header)).toEqual(["Item", "Amount", "Action", "Status", "Bank answer", "Bank reference", "When"]);
    expect(cols.filter((c) => c.defaultHidden).map((c) => c.key)).toEqual(["attempts", "recon"]);
  });
});
