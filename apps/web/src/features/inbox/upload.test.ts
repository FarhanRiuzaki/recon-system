import { afterEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "@/lib/client/api";
import { folderHref, inboxFilesPath, stateSummary, uploadFile } from "./upload";

afterEach(() => { vi.unstubAllGlobals(); setCsrf(null); });

/** A fake XMLHttpRequest: records what was sent, then answers `status`/`body`, reporting upload progress first. */
function fakeXhr(status: number, body: unknown) {
  const sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  class X {
    status = 0; responseText = ""; upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
    private h: Record<string, string> = {}; private m = ""; private u = "";
    open(m: string, u: string) { this.m = m; this.u = u; }
    setRequestHeader(k: string, v: string) { this.h[k.toLowerCase()] = v; }
    abort() { this.onabort?.(); }
    send(b: unknown) {
      sent.push({ method: this.m, url: this.u, headers: this.h, body: b });
      this.upload.onprogress?.({ loaded: 1, total: 4, lengthComputable: true });
      this.upload.onprogress?.({ loaded: 4, total: 4, lengthComputable: true });
      this.status = status; this.responseText = JSON.stringify(body); this.onload?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", X);
  return sent;
}

describe("uploadFile", () => {
  it("POSTs the raw file with its name URL-encoded and the CSRF token, reporting progress", async () => {
    const sent = fakeXhr(201, { name: "Laporan ACT.txt", size: 3, sha256: "x" });
    setCsrf("tok");
    const file = new File(["abc"], "Laporan ACT.txt");
    const seen: number[] = [];
    expect(await uploadFile("s1", "act", file, { onProgress: (r) => seen.push(r) })).toEqual({ name: "Laporan ACT.txt", size: 3, sha256: "x" });
    expect([sent[0]!.method, sent[0]!.url, sent[0]!.headers["x-file-name"], sent[0]!.headers["x-csrf-token"], sent[0]!.body]).toEqual(["POST", "/api/spaces/s1/inbox/folders/act/files", "Laporan%20ACT.txt", "tok", file]);
    expect(seen).toEqual([0.25, 1]);
  });

  it("throws the API's message on a refusal", async () => {
    fakeXhr(409, { error: { code: "duplicate", message: "A file named a.txt is already in this folder. Delete it first." } });
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
