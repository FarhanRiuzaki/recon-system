"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@starterkit/ui/lib/cn";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@starterkit/ui/ui/dropdown-menu";
import { Icon } from "@starterkit/ui/ui/icon";
import { ChevronsUpDownIcon, RefreshIcon } from "@starterkit/ui/ui/icons";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@starterkit/ui/ui/tooltip";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { usePrefs } from "@/lib/client/prefs-context";
import { ROLE_LABEL, spaceHref, useSpaces } from "./use-spaces";

/** The pages every space has (phase 1: members); switching keeps one of these, anything else opens members. */
const SPACE_PAGES = ["members"] as const;
type SpacePage = (typeof SPACE_PAGES)[number];
// The menu's body loads on the first open (space-menu.tsx), like the account menu's.
const SpaceMenuItems = dynamic(() => import("./space-menu").then((m) => m.SpaceMenuItems, () => SpaceMenuFailure), {
  ssr: false,
  loading: () => <DropdownMenuItem disabled>Loading spaces…</DropdownMenuItem>,
});
function SpaceMenuFailure() {
  return <DropdownMenuItem onSelect={() => window.location.reload()}>Couldn&apos;t load your spaces. Reload page</DropdownMenuItem>;
}

const spaceOf = (path: string) => /^\/spaces\/([^/]+)/.exec(path)?.[1];

/** Where switching to space `id` goes from `path`: the same page under the new space when every space has it, else members. */
export function switchHref(path: string, id: string): string {
  const page = /^\/spaces\/[^/]+\/([^/]+)/.exec(path)?.[1];
  return spaceHref(id, SPACE_PAGES.includes(page as SpacePage) ? (page as SpacePage) : "members");
}

/** The space the switcher shows: the one in the URL, else the remembered one, else the first (name A–Z). */
export function currentSpace<S extends { id: string }>(items: readonly S[], path: string, remembered: string | null): S | undefined {
  const inUrl = spaceOf(path);
  return items.find((s) => s.id === inUrl) ?? items.find((s) => s.id === remembered) ?? items[0];
}

export const rolesText = (s: SpaceRowDto) => s.roles.map((r) => ROLE_LABEL[r]).join(", ") || "Not a member";

export function Mark({ name }: { name: string }) {
  return <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-sm bg-action text-body-sm font-medium text-action-fg">{name.trim().charAt(0).toUpperCase()}</span>;
}

/**
 * Space switcher under the logo (sidebar), or in the phone drawer (`drawer`). One space: a label, not a button. Two or
 * more: a menu of the caller's spaces (menuitemradio rows: mark, name, code, roles here), with a search from 5 spaces.
 * In the rail (768–1279 px, or the sidebar collapsed) only the mark shows, the name in a tooltip. The list is
 * server-prefetched in `(main)/layout.tsx`; no spaces → nothing here (`/spaces` explains). Picking a space remembers
 * it (`space` pref) and opens the same page in it (`switchHref`).
 */
export function SpaceSwitcher({ drawer }: { drawer?: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const { prefs, update } = usePrefs();
  const q = useSpaces();
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  const [used, setUsed] = useState(false);
  const loading = useDelayedFlag(q.isPending);
  const compact = !drawer && prefs.sidebar === "collapsed";
  // Visible only where the full switcher fits: the drawer, or the expanded sidebar from 1280 px.
  const wide = drawer ? "grid" : compact ? "hidden" : "hidden xl:grid";
  const box = cn("flex w-full items-center gap-2.5 rounded-md text-left", drawer ? "h-12 border border-line bg-card px-2 shadow-xs"
    : cn("mx-auto size-9 justify-center", !compact && "xl:h-12 xl:w-full xl:justify-start xl:border xl:border-line xl:bg-card xl:px-2 xl:shadow-xs"));

  // Prefetched with the layout: pending only when that read failed and the browser asks again.
  if (q.isPending) return loading ? <Skeleton className={cn(box, "border-0 shadow-none")} /> : <div className={box} aria-hidden="true" />;
  if (q.isError) {
    return (
      <button type="button" onClick={() => void q.refetch()} aria-label="Couldn't load your spaces. Try again"
        className={cn(box, "cursor-pointer text-body-sm text-fg-2 hover:bg-tray")}>
        <Icon icon={RefreshIcon} className="size-4 shrink-0 text-down-ink" /><span className={cn("min-w-0", wide)}>Couldn&apos;t load spaces. Try again</span>
      </button>
    );
  }
  const items = q.data.items;
  const current = currentSpace(items, path, prefs.space);
  if (!current) return null;

  const label = (
    <>
      <Mark name={current.name} />
      <span className={cn("min-w-0 flex-1 leading-tight", wide)}>
        <span className="truncate text-body-sm font-medium text-fg">{current.name}</span>
        <span className="truncate text-caption text-fg-3">{rolesText(current)}</span>
      </span>
    </>
  );
  const tooltip = <TooltipContent side="right" className={cn(drawer && "hidden", !compact && "xl:hidden")}>{current.name}</TooltipContent>;

  if (items.length === 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild><div data-slot="space-switcher" className={box} aria-label={`Space: ${current.name}`} role="group">{label}</div></TooltipTrigger>
        {tooltip}
      </Tooltip>
    );
  }

  const pick = (id: string) => { update({ space: id }); router.push(switchHref(path, id)); };
  return (
    <DropdownMenu open={open} onOpenChange={(o) => { setOpen(o); setTip(false); if (o) setUsed(true); }}>
      <Tooltip open={tip && !open} onOpenChange={setTip}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" data-slot="space-switcher" aria-label={`${current.name}, switch space`}
              className={cn(box, "cursor-pointer outline-none hover:bg-tray focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary data-[state=open]:border-fg-4")}>
              {label}
              <Icon icon={ChevronsUpDownIcon} className={cn("size-4 shrink-0 text-fg-3", drawer ? "block" : compact ? "hidden" : "hidden xl:block")} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
      <DropdownMenuContent side={compact ? "right" : "bottom"} align="start" sideOffset={compact ? 8 : 4} className="w-72">
        {used && <SpaceMenuItems items={items} currentId={current.id} onPick={pick} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
