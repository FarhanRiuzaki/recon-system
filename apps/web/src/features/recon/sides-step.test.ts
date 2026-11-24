// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReconDto, ReconVersionDto } from "@starterkit/shared/contracts/recon";
import type { SourceDto, SourceRowDto } from "@starterkit/shared/contracts/sources";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import { sideSourceOptions, sourceDetail, spaceDetail } from "@/lib/shared/queries";
import { Builder } from "./builder";
import { NewRecon } from "./new-recon";
import { defaultSpec } from "./spec-model";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/spaces/sp/recons/new",
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// nothing answers: what isn't seeded below stays pending
globalThis.fetch = () => new Promise<Response>(() => {});

const SP = "sp";
const row = (id: string, name: string): SourceRowDto => ({
  id, spaceId: SP, code: id, name, kind: "file_inbox", status: "active", shared: false, publishedVersion: 1, owner: null,
  health: { state: "healthy", businessDate: "2026-11-04", lagSeconds: null, completeThrough: null, reason: null, missingDate: null, lastError: null, lastReadAt: null },
  rowsToday: 9, quarantinedToday: 0, engine: null, server: null, reads: "/inbox", usedByCount: 2, pending: null, recent: [], lastPull: null, nextRunAt: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
});
const published = {
  fields: [{ name: "ref", type: "string" }, { name: "amt", type: "decimal" }, { name: "d", type: "date" }],
  mapping: { ext_ref: { field: "ref" }, amount_minor: { field: "amt" }, business_date: { field: "d" } },
};
const detail = (r: SourceRowDto) => ({ ...r, health: { ...r.health!, graceMinutes: null, deadline: null }, drift: null, days: [], usedBy: [], connection: null, shares: [], published: { spec: published }, draft: null }) as unknown as SourceDto;
const A = row("a", "Core ledger"), B = row("b", "Switch file");

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(spaceDetail(SP).key, { roles: ["config_maker"] });
  qc.setQueryData(sideSourceOptions(SP).key, { items: [A, B], total: 2, page: 1, pageSize: 100 });
  for (const s of [A, B]) qc.setQueryData(sourceDetail(SP, s.id).key, detail(s));
  return qc;
}
let root: ReturnType<typeof createRoot> | null = null;
async function render(node: ReactNode) {
  document.body.innerHTML = `<div id="root"></div>`;
  root = createRoot(document.getElementById("root")!);
  await act(async () => root!.render(h(QueryClientProvider, { client: seeded() }, h(TooltipProvider, null, node))));
  await act(() => new Promise((r) => setTimeout(r, 0)));
}
afterEach(() => { act(() => root?.unmount()); root = null; localStorage.clear(); });
/** The step's field labels, in order (a label or a legend each), without the Name and Code a new recon has on top. */
const labels = () => [...document.querySelectorAll("form label, form legend")].map((x) => x.textContent!.trim()).filter((t) => !/^(Name|Code)\*?$/.test(t));

describe("step 1 is the same screen for a new recon and an existing one (owner 24 Nov: harus sama)", () => {
  it("both render the same fields, in the same order, and the sources at a glance", async () => {
    // the new recon with both sources picked, as its browser copy brings them back
    localStorage.setItem(`recon:recon-new:${SP}`, JSON.stringify({ name: "BI-FAST", code: "bi-fast", a: "a", b: "b", spec: defaultSpec(A, B) }));
    await render(h(NewRecon, { spaceId: SP, spaceName: "Space" }));
    const fresh = labels();
    const freshText = document.body.textContent!;

    const spec = defaultSpec(A, B);
    const version = { id: "v1", version: 1, status: "draft", spec, specHash: "h", matchingHash: "h", makerId: null, contributorIds: [], submitterId: null, submittedAt: null, checkerId: null, reviewComment: null, publishedAt: null, simulatedHash: null, warnings: [], createdAt: "", updatedAt: "" } as ReconVersionDto;
    const recon = { id: "r1", name: "BI-FAST", code: "bi-fast", published: null, draft: version } as unknown as ReconDto;
    await render(h(Builder, { spaceId: SP, recon, version, editable: true, canEdit: true, step: 1, reached: 1, onStep: () => {}, exitHref: "/", onSubmitted: () => {} }));
    const existing = labels();

    expect(existing).toContain("Source*");
    expect(existing).toContain("Direction");
    expect(fresh).toEqual(existing);
    for (const text of ["9 records today", "read by 2 recons"]) {
      expect(freshText).toContain(text);
      expect(document.body.textContent).toContain(text);
    }
  });
});
