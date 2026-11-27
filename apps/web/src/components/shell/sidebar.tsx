"use client";

import { Kbd } from "@starterkit/ui/ds/kbd";
import { Brand, LiveCountBadge } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import { SidebarCollapseIcon, SidebarExpandIcon } from "@starterkit/ui/ui/icons";
import { ScrollArea } from "@starterkit/ui/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@starterkit/ui/ui/tooltip";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DUR, usePrefersReducedMotion } from "@starterkit/ui/motion";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { api } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";
import { usePrefs } from "@/lib/client/prefs-context";
import { activeChild, centerScrollTop, countText, importsNavCount, NAV, type NavCount, type NavCounts, navCount, navFor, navLinkName, navSpaceId, onItem, spaceEntry } from "@/lib/shared/nav";
import { APPROVALS_KEY, importIssues, navCountsQuery, spaceOptions } from "@/lib/shared/queries";
import { viewHref } from "@/lib/shared/prefs";
import { goKeys } from "@/lib/shared/shortcuts";
import { NavGlyph } from "./nav-icon";
import { AccountMenu } from "./account-menu";
import { SidebarRailMenu } from "./sidebar-rail-menu";
import { SoonCaption, SoonItem } from "./soon-item";

/**
 * True once the caller's spaces are known to be none (the switcher's list, prefetched by the layout; useSpaces reads
 * the same key). Unknown (loading, failed) counts as having one, so the nav never drops a group on a hiccup.
 */
export function useNoSpace(): boolean {
  const { key, url } = spaceOptions();
  return useQuery({ queryKey: key, queryFn: () => api<Page<unknown>>(url) }).data?.total === 0;
}

/**
 * Where a navigation link goes: `viewHref` (the view last left there), and for a space entry (/spaces, /sources,
 * /recons) straight to the space page its entry would redirect to (`spaceEntry`, from the same list), so a click
 * never stops on the redirect's empty page. The entry itself while the list is unknown.
 */
export function useNavHref(): (href: string) => string {
  const { prefs } = usePrefs();
  const { key, url } = spaceOptions();
  const spaces = useQuery({ queryKey: key, queryFn: () => api<Page<SpaceRowDto>>(url) }).data?.items;
  const current = /^\/spaces\/([^/]+)/.exec(usePathname())?.[1] ?? null;
  return useCallback((href) => {
    const page = NAV.find((n) => n.href === href)?.space;
    return viewHref((page && spaces && spaceEntry(page, spaces, prefs.space, current && decodeURIComponent(current))) || href, prefs);
  }, [prefs, spaces, current]);
}

/** How often the sidebar's counts are read again while the window is open (they also refresh on focus and on a change). */
const NAV_COUNTS_POLL_MS = 30_000;

/**
 * The sidebar's counts (GET …/nav-counts) for the space its space pages link to (navSpaceId), undefined until they
 * arrive: not prefetched, the badges fade in when they do. Under ENGINE_KEY, so a break taken or resolved refreshes
 * them; an invalidation under APPROVALS_KEY (a decision) refetches them too.
 */
export function useNavCounts(): NavCounts | undefined {
  const { prefs } = usePrefs();
  const { key, url } = spaceOptions();
  const spaces = useQuery({ queryKey: key, queryFn: () => api<Page<SpaceRowDto>>(url) }).data?.items;
  const current = /^\/spaces\/([^/]+)/.exec(usePathname())?.[1] ?? null;
  const id = spaces ? navSpaceId(spaces, prefs.space, current && decodeURIComponent(current)) : null;
  const q = navCountsQuery(id ?? "");
  const qc = useQueryClient();
  useEffect(() => {
    if (!id) return;
    return qc.getQueryCache().subscribe((e) => {
      if (e.type === "updated" && e.action.type === "invalidate" && e.query.queryKey[0] === APPROVALS_KEY[0])
        void qc.invalidateQueries({ queryKey: navCountsQuery(id).key, exact: true }, { cancelRefetch: false });
    });
  }, [qc, id]);
  return useQuery({ queryKey: q.key, queryFn: () => api<NavCounts>(q.url), enabled: !!id, refetchInterval: NAV_COUNTS_POLL_MS, refetchOnWindowFocus: true }).data;
}

/** How often the Monitoring badge is read again while the window is open (it also refreshes on focus). */
const IMPORT_ISSUES_POLL_MS = 60_000;

/**
 * The Monitoring badge (GET /api/imports/issues, DEC-066) for a viewer with import.view, undefined until it arrives (not
 * prefetched: the badge fades in like the space counts); global, apart from the space counts.
 */
export function useImportIssues(): number | undefined {
  const { perms } = useAuth();
  return useQuery({
    queryKey: importIssues.key, queryFn: () => api<{ count: number }>(importIssues.url), enabled: perms.has("import.view"),
    refetchInterval: IMPORT_ISSUES_POLL_MS, refetchOnWindowFocus: true,
  }).data?.count;
}

/**
 * A nav item's count badge: at the row's end in the full sidebar and the drawer; at the icon's top-right corner in the
 * 64 px rail (`rail`: always, collapsed; "below-xl": the sidebar's rail below 1280 px). Hidden from screen readers
 * (the link's name carries the count); `title` the full number.
 */
export function NavCountBadge({ count, rail }: { count: NavCount | null; rail?: true | "below-xl" }) {
  if (!count) return null;
  const corner = "absolute -top-1.5 -right-2";
  return <LiveCountBadge value={count.value} tone={count.tone} title={count.name} format={countText}
    className={rail === true ? corner : rail ? "max-xl:absolute max-xl:-top-1.5 max-xl:-right-2" : undefined} />;
}

/**
 * Keeps the current page's item (the visible `aria-current="page"` link, a child over its parent) in view in the
 * navigation's own scroll box: when it isn't fully visible, the box (never the page) scrolls it to the middle. Instant
 * on the first run and under reduced motion, smooth after a navigation (`key`, the path).
 */
export function centerCurrent(box: HTMLElement | null, smooth: boolean) {
  const item = box && [...box.querySelectorAll<HTMLElement>('[aria-current="page"]')].filter((el) => el.getClientRects().length > 0).at(-1);
  if (!box || !item) return;
  const top = centerScrollTop(box, { offsetTop: item.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop, offsetHeight: item.offsetHeight });
  if (top !== null) box.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
}
function useCenterCurrent(ref: RefObject<HTMLElement | null>, key: string) {
  const reduced = usePrefersReducedMotion();
  const first = useRef(true);
  useLayoutEffect(() => {
    centerCurrent(ref.current, !first.current && !reduced);
    first.current = false;
    // only a navigation moves the list, not a change of the motion setting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ref]);
}

/**
 * Sidebar. 248 px from 1280 px (`xl`), collapsible to the 64 px icon rail (preference per viewer, kept in a cookie);
 * 768–1279 px it is always the rail, so the page never scrolls sideways; below 768 px it is not shown and the same
 * sections open from the top bar's menu button (MobileNav, a drawer). Sections come from
 * `navFor(perms, useNoSpace())`: a link the viewer cannot open is not shown, nor the Space group while they are in no space. An item's `children` (views of its page, or pages
 * below it such as /ds/forms) open under it, on a guide line, while its page or one below it is open in the expanded
 * sidebar (≥ 1280 px); in the rail the item is a menu button listing them (SidebarRailMenu). Account controls live in the sidebar footer. The logo nodes come
 * from the server (AppShell), so the wordmark's path data stays out of the client bundle; `space` (the space switcher)
 * sits under them.
 */
export function Sidebar({ mark, wordmark, space }: { mark: ReactNode; wordmark: ReactNode; space?: ReactNode }) {
  const path = usePathname();
  const sp = useSearchParams();
  const { perms } = useAuth();
  const { prefs, update } = usePrefs();
  const navHref = useNavHref();
  const sections = navFor(perms, useNoSpace());
  const counts = useNavCounts();
  const issues = useImportIssues();
  const scrollRef = useRef<HTMLDivElement>(null);
  useCenterCurrent(scrollRef, path);
  const collapsed = prefs.sidebar === "collapsed";
  // The toggle swaps between two buttons, so the pressed one unmounts; hand keyboard focus to its counterpart.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    toggleRef.current?.focus();
  }, [collapsed]);
  // Labels keep `hidden` in the rail (never animated out); they fade in once when the sidebar mounts and once on
  // expand, as the width opens. The class goes after that: a label that turns visible again (the window crossing
  // 1280 px, a full-page capture) would replay the fade from opacity 0 and look dimmed.
  const [reveal, setReveal] = useState(true);
  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => setReveal(false), DUR.slow * 1000);
    return () => clearTimeout(t);
  }, [reveal]);
  const toggle = (sidebar: "collapsed" | "expanded") => { toggled.current = true; if (sidebar === "expanded") setReveal(true); update({ sidebar }); };
  const label = (cls: string) => (collapsed ? "hidden" : cn(cls, reveal && "animate-reveal-in"));
  // The rail (below 1280 px, or collapsed): every control is a centred 36 px square; expanded, a full-width row.
  const square = collapsed ? "mx-auto size-9" : "max-xl:mx-auto max-xl:size-9";
  return (
    <aside data-print="hide" aria-label="Main navigation" className={cn("animate-shell-side motion-safe:transition-sidebar sticky top-0 flex h-svh w-16 shrink-0 flex-col px-3 py-4 max-md:hidden", !collapsed && "xl:w-62")}>
      <div className={cn("flex h-9 items-center justify-center px-1.5", !collapsed && "xl:justify-start")}>
        {/* Below 1280 px the sidebar is always the rail, so the expanded slot keeps the mark until xl. */}
        <Brand collapsed={collapsed} mark={mark}
          wordmark={<><span className="contents xl:hidden">{mark}</span><span className="hidden xl:contents">{wordmark}</span></>} />
        {!collapsed && (
          <button ref={toggleRef} type="button" onClick={() => toggle("collapsed")} aria-label="Collapse sidebar" aria-expanded="true"
            className="ml-auto hidden size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-3 hover:bg-tray hover:text-fg xl:inline-grid">
            <Icon icon={SidebarCollapseIcon} className="size-4" />
          </button>
        )}
      </div>
      {space && <div className="mt-3">{space}</div>}
      <div aria-hidden="true" className="mx-1.5 mt-3 border-t border-line" />
      <nav data-slot="sidebar-nav" aria-label="Menu" className="mt-1 flex min-h-0 flex-1 flex-col">
        <ScrollArea ref={scrollRef} className="-mx-1 px-1" thumbClassName="-right-2">
        {sections.map((s, si) => (
          <div key={s.id} role="group" aria-labelledby={`nav-section-${s.id}`} className={cn("grid gap-0.5", si > 0 && "mt-3")}>
            {/* The rail has no group labels: a hairline separates the groups instead. */}
            {si > 0 && <div aria-hidden="true" className={cn("mx-2 mb-2 border-t border-line", !collapsed && "xl:hidden")} />}
            {/* Hidden in the rail, still names the group (aria-labelledby reads hidden text). */}
            <span key={`${s.id}-${collapsed}`} id={`nav-section-${s.id}`} className={cn("eyebrow hidden px-2.5 pt-2 pb-2 text-fg-3", label("xl:block"))}>{s.label}</span>
            {/* One caption per group, only in the expanded sidebar; in the rail the soon items' tooltip says it. */}
            <SoonCaption items={s.items} id={`nav-soon-${s.id}`} className={cn("-mt-1 hidden px-2.5 pb-2 text-caption text-fg-3", label("xl:block"))} />
            {s.items.map((n) => {
              if (n.soon) return <SoonItem key={n.href} item={n} captionId={`nav-soon-${s.id}`} text={cn("hidden", label("xl:inline"))} dot={collapsed ? undefined : "xl:hidden"} hideTip={collapsed ? undefined : "xl:hidden"} row={cn("h-9 justify-center", square, !collapsed && "xl:h-8 xl:justify-start xl:text-body-sm")} />;
              const active = onItem(path, n);
              const child = active ? activeChild(n, path, sp) : null;
              const count = navCount(n.space, counts) ?? importsNavCount(n.href, issues);
              return (
                <div key={n.href} className="grid gap-0.5">
                {n.children?.length ? <SidebarRailMenu item={n} active={active} child={child} collapsed={collapsed} /> : null}
                {(!n.children?.length || !collapsed) && <Tooltip>
                  <TooltipTrigger asChild>
                    {/* aria-label: the text label is hidden in the rail; the link keeps its name. */}
                    {/* With a child view open (expanded sidebar), the child carries the highlight and the item just reads fg. */}
                    <Link href={navHref(n.href)} aria-label={navLinkName(n.label, count)} aria-current={active && !(child && !collapsed) ? "page" : undefined}
                      className={cn("relative flex h-9 items-center justify-center gap-2.5 rounded-md border px-2.5 text-body text-fg-2 transition-colors duration-(--dur-fast)",
                        square, !collapsed && "xl:h-8 xl:justify-start xl:text-body-sm",
                        !!n.children?.length && "hidden xl:flex",
                        active ? "border-line bg-raised text-fg" : "border-transparent hover:bg-tray hover:text-fg",
                        active && child && !collapsed && "xl:border-transparent xl:bg-transparent xl:shadow-none")}>
                      <NavGlyph icon={n.icon} className="size-4 shrink-0" />
                      <span key={`label-${collapsed}`} className={cn("hidden min-w-0 flex-1 truncate", label("xl:inline"))}>{n.label}</span>
                      <NavCountBadge count={count} rail={collapsed || "below-xl"} />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" className={cn(!collapsed && "xl:hidden")}>{navLinkName(n.label, count)}{n.shortcut && <Kbd keys={goKeys(n.shortcut)} />}</TooltipContent>
                </Tooltip>}
                {active && n.children && !collapsed && (
                  <div className="nav-tree ml-4.5 hidden gap-0.5 pl-3 xl:grid">
                    {n.children!.map((c) => (
                      <Link key={c.href} href={c.href} aria-current={c === child ? "page" : undefined}
                        className={cn("relative flex h-8 items-center gap-2.5 rounded-md border px-2.5 text-body-sm text-fg-2 transition-colors duration-(--dur-fast)",
                          c === child ? "border-line bg-raised text-fg" : "border-transparent hover:bg-tray hover:text-fg")}>
                        <span aria-hidden="true" className="nav-tree-branch" /><NavGlyph icon={c.icon} className="size-4 shrink-0" /><span className="min-w-0 truncate">{c.label}</span>
                      </Link>
                    ))}
                  </div>
                )}
                </div>
              );
            })}
          </div>
        ))}
        </ScrollArea>
      </nav>
      <div className="grid gap-2 border-t border-line pt-3">
        <AccountMenu compact={collapsed} />
        {collapsed && (
          // The rail is wide enough for the logo only, so the expand toggle sits at the bottom (≥ 1280 only).
          <button ref={toggleRef} type="button" onClick={() => toggle("expanded")} aria-label="Expand sidebar" aria-expanded="false"
            className="hidden h-9 cursor-pointer place-items-center rounded-md text-fg-3 hover:bg-tray hover:text-fg xl:grid">
            <Icon icon={SidebarExpandIcon} className="size-4" />
          </button>
        )}
      </div>
    </aside>
  );
}
