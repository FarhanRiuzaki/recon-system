import { describe, expect, it } from "bun:test";
import { folderOfPath, nameMismatch, spaceRoot, worstState } from "../../rules";

describe("spaceRoot", () => {
  it("is the space code under the first inbox root; none without roots", () => {
    expect(spaceRoot(["/data/inbox", "/other"], "msi")).toBe("/data/inbox/msi");
    expect(spaceRoot([], "msi")).toBeNull();
  });
});

describe("worstState", () => {
  it("failed > duplicate > waiting > ingested; no source = waiting", () => {
    expect(worstState(["ingested", "waiting"])).toBe("waiting");
    expect(worstState(["duplicate", "failed"])).toBe("failed");
    expect(worstState(["ingested", "duplicate"])).toBe("duplicate");
    expect(worstState(["ingested"])).toBe("ingested");
    expect(worstState([])).toBe("waiting");
  });
});

describe("folderOfPath", () => {
  const roots = ["/data/inbox"], codes = ["msi", "ctop"];
  it("names the space and folder a path sits in, by the resolved path", () => {
    expect(folderOfPath(roots, codes, "/data/inbox/msi/act")).toEqual({ code: "msi", folder: "act" });
    expect(folderOfPath(roots, codes, "/data/inbox/msi/../ctop/x")).toEqual({ code: "ctop", folder: "x" });
    expect(folderOfPath(roots, codes, "/data/inbox/msi/act/")).toEqual({ code: "msi", folder: "act" });
  });
  it("a space root itself has no folder; a path outside every space root is none", () => {
    expect(folderOfPath(roots, codes, "/data/inbox/msi")).toEqual({ code: "msi", folder: null });
    expect(folderOfPath(roots, codes, "/data/inbox/act")).toBeNull();
    expect(folderOfPath(roots, codes, "/elsewhere/msi/act")).toBeNull();
    expect(folderOfPath([], codes, "/data/inbox/msi/act")).toBeNull();
  });
});

describe("nameMismatch (owner 25 Nov: a renamed file is caught)", () => {
  it("text and workbooks must carry their own extension; a match is null", () => {
    expect(nameMismatch("act.csv", "text")).toBeNull();
    expect(nameMismatch("ACT.XLSX", "xlsx")).toBeNull();
    expect(nameMismatch("old.xls", "xls")).toBeNull();
    expect(nameMismatch("act.csv", "xlsx")).toBe("This file is an Excel workbook but is named .csv. Rename it .xlsx and upload it again.");
    expect(nameMismatch("act.txt", "xls")).toBe("This file is an Excel workbook but is named .txt. Rename it .xls and upload it again.");
    expect(nameMismatch("act.xlsx", "text")).toBe("This file is text, not an Excel workbook, but is named .xlsx. Rename it .csv or .txt and upload it again.");
    expect(nameMismatch("act.xlsx", "xls")).toBe("This file is an older Excel workbook (.xls) but is named .xlsx. Rename it .xls and upload it again.");
    expect(nameMismatch("act.xls", "xlsx")).toBe("This file is an Excel workbook (.xlsx) but is named .xls. Rename it .xlsx and upload it again.");
  });
});
