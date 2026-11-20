// @vitest-environment happy-dom
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { act, createElement as h, type ReactNode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteSkeleton, type Section } from "./route-skeleton";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/" }));
vi.mock("@/lib/client/auth-context", () => ({ useAuth: () => ({ can: () => true }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHAPE: readonly Section[] = [{ kind: "header", h: 50 }, { kind: "kpi", h: 130, count: 4 }, { kind: "table", chrome: 96, rows: 5 }];
const roots: Root[] = [];
const holders = () => document.querySelectorAll("[data-frozen-holder]").length;
const settle = () => act(() => new Promise((r) => setTimeout(r, 400))); // past every fade and cap

/** The page region as PageTransition renders it, with the page on screen. Returns where a route's shape mounts. */
function pageRegion(): HTMLElement {
  const region = document.body.appendChild(document.createElement("div"));
  const page = region.appendChild(document.createElement("div"));
  page.setAttribute("data-page", "");
  page.append("Dashboard");
  return page.appendChild(document.createElement("div"));
}
async function mount(into: HTMLElement, node: ReactNode): Promise<Root> {
  const root = createRoot(into);
  roots.push(root);
  await act(async () => root.render(node));
  return root;
}
const never = new Promise<never>(() => undefined);
function Pending(): ReactNode { throw never; }

afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  await settle();
  document.body.innerHTML = "";
});

describe("RouteSkeleton's frozen copy of the previous page", () => {
  it("goes when the shape unmounts (the page arrived) within its first 150 ms", async () => {
    const root = await mount(pageRegion(), h(RouteSkeleton, { sections: SHAPE }));
    expect(holders()).toBe(1);
    await act(async () => root.unmount());
    await settle();
    expect(holders()).toBe(0);
  });

  it("goes although the next route's shape rendered and was thrown away (a render that never commits)", async () => {
    const slot = pageRegion();
    const first = await mount(slot, h(RouteSkeleton, { sections: SHAPE }));
    expect(holders()).toBe(1);
    // The next navigation's shape renders while the first is on screen (it sees a shape in the page region, so it
    // reaches for the copy), but its subtree suspends and React never commits it.
    await mount(document.body.appendChild(document.createElement("div")),
      h(Suspense, { fallback: null }, h(RouteSkeleton, { sections: SHAPE }), h(Pending)));
    await act(async () => first.unmount());
    await settle();
    expect(holders()).toBe(0);
  });

  it("is handed to the next route's shape mounting in the same commit, and only one copy is ever up", async () => {
    const slot = pageRegion();
    const root = await mount(slot, h(RouteSkeleton, { key: "a", sections: SHAPE }));
    await act(async () => root.render(h(RouteSkeleton, { key: "b", sections: SHAPE })));
    await act(() => Promise.resolve());
    expect(holders()).toBe(1);
    await settle();
    expect(holders()).toBe(0);
  });
});

describe("RouteSkeleton's shape", () => {
  const tree = (child: string) => ({ parentTree: ["", { children: [child, {}] }] }) as never;
  const sections = async (child: string) => {
    const slot = document.body.appendChild(document.createElement("div"));
    await mount(slot, h(LayoutRouterContext.Provider, { value: tree(child) }, h(RouteSkeleton, { sections: SHAPE })));
    return slot.querySelector("[data-route-skeleton]")!.children.length;
  };

  it("is its own page's sections for its own page, a neutral title and block for a route below its folder", async () => {
    expect(await sections('__PAGE__?{"step":"1"}')).toBe(3);
    expect(await sections("spaces")).toBe(2);
  });
});

describe("loading.tsx of the space pages", () => {
  // A page listed here shows the neutral shape of the boundary above it, on purpose: say why. None today.
  const INHERITS: Record<string, string> = {};
  const space = path.join(import.meta.dirname, "../app/(main)/spaces/[spaceId]");
  const pages = (readdirSync(space, { recursive: true }) as string[]).filter((f) => path.basename(f) === "page.tsx").map(path.dirname);

  it("every page under spaces/[spaceId] has its own loading shape, or is listed with its reason", () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.filter((dir) => !existsSync(path.join(space, dir, "loading.tsx")) && !INHERITS[dir])).toEqual([]);
    expect(Object.keys(INHERITS).filter((dir) => !pages.includes(dir))).toEqual([]); // no stale entry
  });
});
