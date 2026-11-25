// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewBody, useSpecPreview } from "./use-spec-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const calls: { url: string; body: unknown }[] = [];
let refuse: string | null = null;
vi.mock("@/lib/client/api", () => {
  class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
  return {
    ApiError,
    api: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (refuse) throw new ApiError(400, "bad_request", refuse);
      return { lines: 0, ok: 0, skipped: 0, quarantined: 0, columns: [], records: [], quarantine: [] };
    }),
    errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

let root: Root | null = null;
beforeEach(() => { calls.length = 0; refuse = null; vi.useFakeTimers(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; vi.useRealTimers(); });
const ids = { sourceId: "s1", versionId: "v1" };
function Probe(p: { spec: object; enabled?: boolean; sampleId?: string | null }) {
  const state = useSpecPreview({ spaceId: "sp", ids, spec: p.spec as never, file: true, sampleId: p.sampleId ?? "smp", sample: "", fileName: "", businessDate: "", enabled: p.enabled ?? true });
  return h("output", null, JSON.stringify(state.field));
}

describe("previewBody", () => {
  it("a detected sample by id, a pasted sample with its name, a database source with its date", () => {
    expect(previewBody({ file: true, sampleId: "x", sample: "", fileName: "", businessDate: "", spec: {} as never })).toEqual({ sampleId: "x", spec: {} });
    expect(previewBody({ file: true, sampleId: null, sample: "a|b", fileName: "act.txt", businessDate: "", spec: {} as never })).toEqual({ sample: "a|b", fileName: "act.txt", spec: {} });
    expect(previewBody({ file: false, sampleId: null, sample: "", fileName: "", businessDate: "2026-11-25", spec: {} as never })).toEqual({ spec: {}, businessDate: "2026-11-25" });
  });
});

describe("useSpecPreview", () => {
  it("two changes within 400 ms send one preview, with the second spec", async () => {
    const host = document.createElement("div"); root = createRoot(host);
    await act(async () => root!.render(h(Probe, { spec: { a: 1 } })));
    await act(async () => { vi.advanceTimersByTime(200); root!.render(h(Probe, { spec: { a: 2 } })); });
    await act(async () => { vi.advanceTimersByTime(450); await Promise.resolve(); });
    expect(calls).toEqual([{ url: "/api/spaces/sp/sources/s1/versions/v1/preview", body: { sampleId: "smp", spec: { a: 2 } } }]);
  });

  it("sends nothing while off", async () => {
    const host = document.createElement("div"); root = createRoot(host);
    await act(async () => root!.render(h(Probe, { spec: { a: 1 }, enabled: false })));
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(calls).toEqual([]);
  });

  it("a refusal that names a field is kept with its path, for the mapper to show where it is", async () => {
    refuse = "Check the expression at derive.net: unknown function";
    const host = document.createElement("div"); root = createRoot(host);
    await act(async () => root!.render(h(Probe, { spec: { a: 1 } })));
    await act(async () => { vi.advanceTimersByTime(450); await Promise.resolve(); await Promise.resolve(); });
    expect(JSON.parse(host.textContent ?? "null")).toEqual({ path: "derive.net", reason: "unknown function" });
  });
});
