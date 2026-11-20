"use client";

import { cn } from "@starterkit/ui/lib/cn";
import { Drawer, DrawerClose, DrawerContent, DrawerTrigger } from "@starterkit/ui/ui/drawer";
import { Icon } from "@starterkit/ui/ui/icon";
import { CloseIcon, MenuIcon } from "@starterkit/ui/ui/icons";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/client/auth-context";
import { activeChild, navFor, onItem } from "@/lib/shared/nav";
import { NavGlyph } from "./nav-icon";
import { AccountMenu } from "./account-menu";
import { SoonCaption, SoonItem } from "./soon-item";
import { useNavHref, useNoSpace } from "./sidebar";

const ICON_BUTTON = "inline-grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-2 hover:bg-tray hover:text-fg";

/**
 * Phone navigation (below 768 px, and on a touch tablet up to 1279 px, where the rail's hover labels can't be read; from 1280 the full sidebar has them; the top bar's
 * menu button): the sidebar's sections in a drawer from the left
 * (packages/ui `Drawer`, a deferred chunk). Items are 44 px. It closes on any route change (`closeOn`), on a tap on an
 * item (also the current page), on Escape and on the scrim; focus then returns to the menu button. `space`: the full
 * space switcher, under the logo.
 */
export function MobileNav({ wordmark, space }: { wordmark: ReactNode; space?: ReactNode }) {
  const path = usePathname();
  const sp = useSearchParams();
  const { perms } = useAuth();
  const navHref = useNavHref();
  const noSpace = useNoSpace();
  return (
    <Drawer closeOn={path}>
      <DrawerTrigger asChild>
        <button type="button" aria-label="Open navigation" className={cn(ICON_BUTTON, "-ml-1 md:pointer-fine:hidden xl:hidden")}>
          <Icon icon={MenuIcon} className="size-5" />
        </button>
      </DrawerTrigger>
      <DrawerContent title="Navigation">
        <div className="flex h-14 shrink-0 items-center justify-between pr-3 pl-4">
          {wordmark}
          <DrawerClose asChild>
            <button type="button" aria-label="Close navigation" className={ICON_BUTTON}><Icon icon={CloseIcon} className="size-4" /></button>
          </DrawerClose>
        </div>
        {space && <div className="px-3 pb-3">{space}</div>}
        <nav data-slot="sidebar-nav" aria-label="Menu" className="scroll-quiet flex-1 overflow-y-auto px-3 pb-4">
          {navFor(perms, noSpace).map((s, si) => (
            <div key={s.id} role="group" aria-labelledby={`drawer-section-${s.id}`} className={cn("grid gap-0.5", si > 0 && "mt-4")}>
              <span id={`drawer-section-${s.id}`} className="eyebrow px-2.5 pt-2 pb-2 text-fg-3">{s.label}</span>
              <SoonCaption items={s.items} id={`drawer-soon-${s.id}`} className="-mt-1 px-2.5 pb-1 text-caption text-fg-3" />
              {s.items.map((n) => {
                if (n.soon) return <SoonItem key={n.href} item={n} captionId={`drawer-soon-${s.id}`} drawer />;
                const active = onItem(path, n);
                const child = active ? activeChild(n, path, sp) : null;
                return (
                  <div key={n.href} className="grid gap-0.5">
                  <DrawerClose asChild>
                    <Link href={navHref(n.href)} aria-current={active && !child ? "page" : undefined}
                      className={cn("relative flex h-11 items-center gap-3 rounded-md border px-2.5 text-body text-fg-2",
                        active && !child ? "border-line bg-raised text-fg" : active ? "border-transparent text-fg" : "border-transparent hover:bg-tray hover:text-fg")}>
                      <NavGlyph icon={n.icon} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{n.label}</span>
                    </Link>
                  </DrawerClose>
                  {active && n.children && (
                    <div className="nav-tree ml-4.5 grid gap-0.5 pl-3">
                      {n.children!.map((c) => (
                        <DrawerClose key={c.href} asChild>
                          <Link href={c.href} aria-current={c === child ? "page" : undefined}
                            className={cn("relative flex h-11 items-center gap-3 rounded-md border px-2.5 text-body text-fg-2",
                              c === child ? "border-line bg-raised text-fg" : "border-transparent hover:bg-tray hover:text-fg")}>
                            <span aria-hidden="true" className="nav-tree-branch" /><NavGlyph icon={c.icon} className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{c.label}</span>
                          </Link>
                        </DrawerClose>
                      ))}
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="border-t border-line p-3 pb-safe"><AccountMenu drawer /></div>
      </DrawerContent>
    </Drawer>
  );
}
