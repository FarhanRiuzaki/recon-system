// The Data pane's group heading of a side's source record (owner 26 Nov: "BI-FAST SWITCH · SETTLEMENT · BI-FAST SWITCH · SETTLEMENT").
import { describe, expect, it } from "bun:test";
import { sideGroupLabel } from "../../rules";

describe("sideGroupLabel", () => {
  it("the side's label and its source's name, once when they read the same", () => {
    expect(sideGroupLabel("Side A", "KSEI file")).toBe("Side A · KSEI file");
    expect(sideGroupLabel("BI-FAST Switch · Settlement", "BI-FAST Switch · Settlement")).toBe("BI-FAST Switch · Settlement");
    expect(sideGroupLabel(" core banking ", "Core Banking")).toBe("core banking");
    expect(sideGroupLabel("", "Core banking")).toBe("Core banking");
  });
});
