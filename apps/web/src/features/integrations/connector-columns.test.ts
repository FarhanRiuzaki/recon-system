import { describe, expect, it } from "vitest";
import { COLUMNS, linkChip } from "./connectors-page";

describe("connectors list (audit §5.8)", () => {
  it("seven shown, Changed hidden until chosen", () => {
    expect(COLUMNS.filter((c) => !c.defaultHidden).map((c) => c.header)).toEqual(["Connector", "Status", "Environment", "Version", "Bank link", "Operations", "Used by"]);
    expect(COLUMNS.filter((c) => c.defaultHidden).map((c) => c.key)).toEqual(["updatedAt"]);
  });
  it("the bank link's last result as a health chip; never called is none", () => {
    expect(linkChip({ state: "none", failures: 0 })).toBeNull();
    expect(linkChip({ state: "answered", failures: 0 })).toEqual({ health: "healthy", label: "Answering" });
    expect(linkChip({ state: "failing", failures: 3 })).toEqual({ health: "degraded", label: "3 calls unanswered" });
    expect(linkChip({ state: "failing", failures: 0 })).toEqual({ health: "degraded", label: "Last call unanswered" });
    expect(linkChip({ state: "paused", failures: 0 })).toEqual({ health: "down", label: "Calls paused" });
  });
});
