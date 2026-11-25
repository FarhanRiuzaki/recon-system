import { describe, expect, it } from "vitest";
import { isInboxUpload } from "./body-limit";
import { INBOX_FOLDER_NAME, INBOX_FOLDERS_MAX, isInboxFileName } from "./inbox";
import { mayDo } from "./spaces";

describe("inbox names", () => {
  it("a file name is a plain name: no folder, no leading dot, no control character, at most 255 bytes", () => {
    for (const n of ["act20261125.txt", "Laporan ACT 25-11.TXT", "résumé.csv"]) expect(isInboxFileName(n), n).toBe(true);
    for (const n of ["", ".x", ".", "..", "a/b", "a\\b", "a\u0000b", "a\nb", "x".repeat(256), "é".repeat(128)]) expect(isInboxFileName(n), JSON.stringify(n)).toBe(false);
    expect(isInboxFileName("x".repeat(255))).toBe(true);
  });

  it("a folder name is lower case letters, digits, _ and -, starting with a letter or digit, at most 64", () => {
    for (const n of ["act", "bal_2", "a-b", "x".repeat(64)]) expect(INBOX_FOLDER_NAME.test(n), n).toBe(true);
    for (const n of ["Act", "-x", "_x", "a.b", "", "x".repeat(65)]) expect(INBOX_FOLDER_NAME.test(n), n).toBe(false);
    expect(INBOX_FOLDERS_MAX).toBe(200);
  });
});

describe("the upload path", () => {
  const space = "0193f2a4-1c2b-7d3e-8f40-1a2b3c4d5e6f";
  it("is exactly POST …/inbox/folders/<folder>/files", () => {
    expect(isInboxUpload(`/v1/spaces/${space}/inbox/folders/act/files`)).toBe(true);
    expect(isInboxUpload(`/v1/spaces/${space}/inbox/folders/act/files?x=1`)).toBe(true);
    expect(isInboxUpload(`/v1/spaces/${space}/inbox/folders/act/files/x`)).toBe(false);
    expect(isInboxUpload(`/v1/spaces/${space}/inbox/folders`)).toBe(false);
    expect(isInboxUpload(`/v1/spaces/${space}/inbox/folders/Act/files`)).toBe(false);
  });
});

describe("inbox space actions (owner, 25 Nov)", () => {
  it("operators and source admins upload; source admins manage; every role views", () => {
    expect(mayDo(["operator"], "uploadInbox")).toBe(true);
    expect(mayDo(["source_admin"], "uploadInbox")).toBe(true);
    expect(mayDo(["space_admin"], "uploadInbox")).toBe(false);
    expect(mayDo(["operator"], "manageInbox")).toBe(false);
    expect(mayDo(["source_admin"], "manageInbox")).toBe(true);
    expect(mayDo(["viewer"], "viewInbox")).toBe(true);
    expect(mayDo(["reviewer"], "viewInbox")).toBe(true);
  });
});
