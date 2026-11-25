import { afterEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "@/lib/client/api";
import { folderHref, inboxFilesPath, stateSummary, uploadFile } from "./upload";

afterEach(() => { vi.unstubAllGlobals(); setCsrf(null); });

describe("uploadFile", () => {
  it("POSTs the raw file to the folder's files with its name URL-encoded and the CSRF token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { seen.push({ url, init }); return Response.json({ name: "Laporan ACT.txt", size: 3, sha256: "x" }, { status: 201 }); }));
    setCsrf("tok");
    const file = new File(["abc"], "Laporan ACT.txt");
    expect(await uploadFile("s1", "act", file)).toEqual({ name: "Laporan ACT.txt", size: 3, sha256: "x" });
    const h = new Headers(seen[0]!.init.headers);
    expect([seen[0]!.url, seen[0]!.init.method, h.get("x-file-name"), h.get("x-csrf-token"), seen[0]!.init.body]).toEqual(["/api/spaces/s1/inbox/folders/act/files", "POST", "Laporan%20ACT.txt", "tok", file]);
  });

  it("throws the API's message on a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "duplicate", message: "A file named a.txt is already in this folder. Delete it first." } }, { status: 409 })));
    await expect(uploadFile("s1", "act", new File(["a"], "a.txt"))).rejects.toThrow("A file named a.txt is already in this folder. Delete it first.");
  });
});

describe("paths", () => {
  it("encode the space and folder; a folder's page keeps the space page", () => {
    expect(inboxFilesPath("s 1", "act")).toBe("/api/spaces/s%201/inbox/folders/act/files");
    expect(folderHref("s1", "act")).toBe("/spaces/s1/inbox?folder=act");
    expect(folderHref("s1", null)).toBe("/spaces/s1/inbox");
  });
});

describe("stateSummary", () => {
  it("lists the non-zero states, worst first, as the folder row shows them", () => {
    expect(stateSummary({ waiting: 1, ingested: 2, duplicate: 0, failed: 1 })).toEqual([["failed", 1], ["waiting", 1], ["ingested", 2]]);
    expect(stateSummary({ waiting: 0, ingested: 0, duplicate: 0, failed: 0 })).toEqual([]);
  });
});
