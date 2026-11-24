import { describe, expect, it } from "vitest";
import { statusTone } from "@/lib/shared/categories";
import { callBy, callChip, callName, originLabel } from "./call-model";

describe("call log words", () => {
  it("outcome chips by meaning: OK green, Rejected, Timeout and Not sent red", () => {
    expect(callChip("ok")).toEqual({ health: statusTone("success"), label: "OK" });
    for (const o of ["rejected", "timeout", "not_sent"] as const) expect(callChip(o).health).toBe(statusTone("failed"));
    expect(callChip("not_sent").label).toBe("Not sent");
  });
  it("an origin reads as words, one this app doesn't know too", () => {
    expect(originLabel("approvals.action")).toBe("Approval action");
    expect(originLabel("integrations.token_check")).toBe("Check token");
    expect(originLabel("billing.invoice_sync")).toBe("Billing · Invoice sync");
  });
  it("who: the person who clicked, else the system on behalf of the approver; a token request has no operation", () => {
    expect(callBy({ actor: { id: "u", name: "Ana" }, onBehalfOf: null })).toEqual({ name: "Ana", note: null });
    expect(callBy({ actor: null, onBehalfOf: { id: "b", name: "Budi" } })).toEqual({ name: "System", note: "for Budi" });
    expect(callBy({ actor: null, onBehalfOf: null })).toEqual({ name: "System", note: null });
    expect(callName({ operation: null })).toBe("Access token");
  });
});
