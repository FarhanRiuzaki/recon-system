import { describe, expect, it } from "vitest";
import { callColumns } from "./calls-page";

describe("call log columns", () => {
  const cols = callColumns(() => {}, () => undefined);
  it("six shown at first, the rest until chosen; one phone title; the outcome can't be hidden", () => {
    expect(cols.filter((c) => !c.defaultHidden).map((c) => c.header)).toEqual(["Call", "Outcome", "Bank answer", "From", "By", "When"]);
    expect(cols.filter((c) => c.defaultHidden).map((c) => c.key)).toEqual(["environment", "durationMs", "externalId", "attempt", "host"]);
    expect(cols.filter((c) => c.mobile === "title").map((c) => c.key)).toEqual(["call"]);
    expect(cols.find((c) => c.key === "outcome")?.hideable).toBe(false);
  });
  it("sorts by the API's keys only", () => {
    expect(cols.filter((c) => c.sortable).map((c) => c.key)).toEqual(["startedAt", "durationMs"]);
  });
});
