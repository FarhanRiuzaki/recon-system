"use client";

import { TimeControls } from "./time-controls";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import { SearchIcon } from "@starterkit/ui/ui/icons";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/client/auth-context";
import { useTrail } from "@/lib/client/crumb-trail";
import { crumbs, isSubPage } from "@/lib/shared/nav";
import { refreshScope } from "@/lib/shared/time-controls";
import { openPalette } from "./command-palette";
import { CrumbList } from "./crumb-list";
import { MobileNav } from "./mobile-nav";
import { useNavHref } from "./sidebar";

const SEARCH = "Search pages";

/** Shared navbar: breadcrumb, scoped calendar range, refresh and search.
 * Phone controls occupy a second row; CSS owns the layout at every width. */
export function TopBar({ mark, wordmark, space }: { mark: ReactNode; wordmark: ReactNode; space?: ReactNode }) {
  const path = usePathname(), tab = useSearchParams().get("tab");
  const { perms } = useAuth();
  const navHref = useNavHref();
  const list = crumbs(path, perms);
  const sub = isSubPage(path);
  const trail = useTrail(path);
  return (
    <div data-shell-header data-time-controls={refreshScope(path, tab) ? "visible" : undefined} data-print="hide" className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-line px-6 max-md:sticky max-md:top-0 max-md:z-30 max-md:gap-x-2 max-md:gap-y-0 max-md:min-h-(--topbar-h) max-md:bg-sheet max-md:px-3 max-md:pt-safe">
      <MobileNav wordmark={wordmark} space={space} />
      <span className="contents md:hidden">{mark}</span>
      {/* A route without crumbs keeps the spacer but no empty landmark. */}
      {list.length === 0 ? <div className="flex-1" /> : <nav aria-label="Breadcrumb" className="min-w-0 flex-1 max-md:min-h-14 max-md:content-center">
        <CrumbList items={[...list, ...(sub ? trail : [])]} sub={sub} navHref={navHref} />
      </nav>}
      <div className={cn("md:flex md:h-10 md:w-100 xl:w-128 md:shrink-0 md:items-center md:justify-end", refreshScope(path, tab) ? "max-md:order-last max-md:w-full max-md:pb-2" : "max-md:hidden")}><TimeControls /></div>
      <button type="button" onClick={openPalette} aria-label={SEARCH}
        className="inline-grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-card text-fg-2 transition-colors duration-(--dur-fast) hover:border-fg-4 xl:flex xl:w-44 xl:justify-start xl:gap-2 xl:px-2.5">
        <Icon icon={SearchIcon} className="size-4 shrink-0" /><span className="hidden text-body-sm xl:inline">Search pages…</span>
      </button>
    </div>
  );
}
