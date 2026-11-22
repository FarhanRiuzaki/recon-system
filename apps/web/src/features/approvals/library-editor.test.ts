// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryDetailDto } from "@starterkit/shared/contracts/workflows";
import type { Level } from "@starterkit/shared/workflows";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { url: string; init?: { method?: string; body?: string } }[] = [];
let detail: LibraryDetailDto;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/spaces/s1/workflows/w1", useSearchParams: () => new URLSearchParams() }));
vi.mock("./used-by", () => ({ UsedBy: () => null }));
vi.mock("@/components/route-skeleton", () => ({ LoadingShape: () => null }));
vi.mock("@/lib/client/api", () => ({
  api: async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    if (url.startsWith("/api/users")) return { items: [], total: 0, page: 1, pageSize: 100 };
    return init?.method ? null : detail;
  },
  errorText: (e: unknown) => String(e), isNotFound: () => false, retryUnlessNotFound: () => false,
}));
const { LibraryEditor } = await import("./library-editor");

const full: Level = { name: "Checker", groups: [{ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } }] };
const nobody: Level = { name: "", groups: [{ spaceRoles: [], globalRoles: [], users: [], need: { kind: "any" } }] };
const version = (levels: Level[], name = "Treasury head") => ({
  id: "v2", version: 2, status: "draft" as const, maker: null, submittedBy: null, submittedAt: null, decidedBy: null, decidedAt: null,
  reviewComment: null, overrideReason: null, updatedAt: "2026-11-23T00:00:00Z", spec: { name, levels },
});
const detailOf = (levels: Level[]): LibraryDetailDto => ({
  id: "w1", name: "Treasury head", archived: false, published: null, open: version(levels), globalRoles: [], people: [], canEdit: true, reviewBlocked: null, overrideOnly: false,
});

let root: Root;
async function mount(levels: Level[]) {
  detail = detailOf(levels);
  document.body.innerHTML = `<div id="root"></div>`;
  root = createRoot(document.getElementById("root")!);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(h(QueryClientProvider, { client: qc }, h(TooltipProvider, null, h(LibraryEditor, { spaceId: "s1", id: "w1" })))));
  await act(() => new Promise((r) => setTimeout(r, 20)));
}
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name)!;
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const patches = () => calls.filter((c) => c.init?.method === "PATCH").map((c) => JSON.parse(c.init!.body!) as { spec: { name: string; levels: Level[] } });

beforeEach(() => { calls.length = 0; });
afterEach(() => { act(() => root.unmount()); });

describe("LibraryEditor autosave never stops on an incomplete draft", () => {
  it("clearing the name saves the draft with an empty name and says Saved", async () => {
    await mount([full]);
    await act(async () => type(document.getElementById("wf-name") as HTMLInputElement, ""));
    await wait(800);
    expect(patches().at(-1)?.spec.name).toBe("");
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/^Saved/);
  });

  it("a level with a group naming nobody is saved as it is", async () => {
    await mount([full]);
    await act(async () => button("Add level 2").click());
    const picker = document.querySelector<HTMLInputElement>('input[aria-label="Level 2, group 1: approvers"]')!;
    expect(picker).toBeTruthy();
    // the new level's group starts with Reviewer; take it out
    await act(async () => button("Remove Reviewer").click());
    await wait(800);
    expect(patches().at(-1)?.spec.levels[1]?.groups[0]).toMatchObject({ spaceRoles: [], globalRoles: [], users: [] });
  });
});

describe("Send for approval on an incomplete draft", () => {
  it("stays focusable with its reason, and a press opens the level whose group names nobody and shows the error there", async () => {
    await mount([full, nobody]);
    const send = button("Send for approval");
    expect(send.hasAttribute("disabled")).toBe(false);
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(send.getAttribute("aria-describedby")!)?.textContent).toMatch(/pick who approves/i);
    const cards = () => [...document.querySelectorAll('[data-slot="level-card"]')];
    expect(cards().map((c) => c.getAttribute("data-mode"))).toEqual(["read", "read"]);
    expect(cards()[1]!.textContent).toContain("Nobody picked yet");
    await act(async () => send.click());
    await wait(20);
    expect(cards().map((c) => c.getAttribute("data-mode"))).toEqual(["read", "edit"]);
    expect(cards()[1]!.textContent).toContain("Pick who approves this group");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Level 2, group 1: approvers");
  });
});
