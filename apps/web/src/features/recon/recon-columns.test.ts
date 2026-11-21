import { describe, expect, it } from "vitest";
import { reconCaption } from "./recon-columns";

describe("reconCaption: the list's second line says the recon's state as its chip does", () => {
  it("names the published version, else the open version's state", () => {
    expect(reconCaption({ publishedVersion: 2, draftStatus: "in_review", code: "bifast" })).toBe("Version 2 · bifast");
    expect(reconCaption({ publishedVersion: null, draftStatus: "in_review", code: "abc" })).toBe("In review · abc");
    expect(reconCaption({ publishedVersion: null, draftStatus: "draft", code: "abc" })).toBe("Draft · abc");
  });
});
