// The break reasons the engine writes are exactly the shared BREAK_REASONS (the items filter `reason` validates
// against that list): a reason added on one side only fails here.
import { describe, expect, it } from "bun:test";
import type { PassSpec } from "@starterkit/shared/contracts/recon";
import { BREAK_REASONS } from "@starterkit/shared/recon";
import { breakReason, NEAR_MISS } from "../../sql/breaks";
import { SUGGESTED_REASON } from "../../sql/days";

describe("break reasons", () => {
  it("are the shared list, no more and no less", () => {
    const pass = (p: Partial<PassSpec>) => ({ no: 1, name: "P", cardinality: "1:1", blocking: [], predicates: [], accept: "auto", on_ambiguous: "break", ...p }) as PassSpec;
    const written = new Set<string>([
      breakReason(pass({ blocking: ["ext_ref"] })), breakReason(pass({ predicates: [{ op: "date_window", field: "business_date", days: 1 }] })),
      ...Object.values(NEAR_MISS), ...Object.values(SUGGESTED_REASON),
    ]);
    expect([...written].sort()).toEqual([...BREAK_REASONS].sort());
  });
});
