"use client";

import { useEffect, useRef, useState } from "react";
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@starterkit/ui/ui/dropdown-menu";
import { Icon } from "@starterkit/ui/ui/icon";
import { CheckIcon, SearchIcon } from "@starterkit/ui/ui/icons";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { Mark, rolesText } from "./space-switcher";

const SEARCH_FROM = 5;
export const SWITCHER_FOOTNOTE = "The space you pick opens next time you sign in. Ask a space admin to join another space.";

/**
 * The switcher menu's body, loaded on the first open (out of every route's first-load JS): a search from 5 spaces, one
 * menuitemradio per space (mark, name, code, the caller's roles there), "Create space" when `onCreate` (space.manage),
 * the footnote.
 */
export function SpaceMenuItems({ items, currentId, onPick, onCreate }: {
  items: readonly SpaceRowDto[]; currentId: string; onPick: (id: string) => void; onCreate?: () => void;
}) {
  const [find, setFind] = useState("");
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A cold keyboard open focused the menu while this chunk loaded: hand focus to the first space, as Radix would.
    const menu = first.current?.closest('[role="menu"]');
    if (menu && document.activeElement === menu) menu.querySelector<HTMLElement>("[role=menuitemradio]")?.focus();
  }, []);
  const term = find.trim().toLowerCase();
  const shown = term ? items.filter((s) => s.name.toLowerCase().includes(term) || s.code.toLowerCase().includes(term)) : items;
  return (
    <div ref={first} className="contents">
      <DropdownMenuLabel className="eyebrow font-normal text-fg-3">Switch space</DropdownMenuLabel>
      {items.length >= SEARCH_FROM && (
        <label className="mx-1 mb-1 flex h-8 items-center gap-2 rounded-md border border-control-border bg-card px-2 focus-within:outline-2 focus-within:outline-primary">
          <Icon icon={SearchIcon} className="size-4 shrink-0 text-fg-3" />
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a space" aria-label="Find a space"
            className="min-w-0 flex-1 bg-transparent text-body-sm text-fg outline-none placeholder:text-fg-3"
            onKeyDown={(e) => {
              // Arrow down moves into the list; other keys stay in the field (the menu would jump to an item by its first letter).
              if (e.key === "ArrowDown") { e.preventDefault(); e.currentTarget.closest("[role=menu]")?.querySelector<HTMLElement>("[role=menuitemradio]")?.focus(); }
              else if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
            }} />
        </label>
      )}
      <DropdownMenuGroup>
        {shown.map((s) => (
          <DropdownMenuItem key={s.id} role="menuitemradio" aria-checked={s.id === currentId} onSelect={() => onPick(s.id)} className="gap-2.5 py-2">
            <Mark name={s.name} />
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="flex min-w-0 items-baseline gap-1.5"><span className="truncate font-medium">{s.name}</span><span className="shrink-0 font-mono text-mono text-fg-3">{s.code}</span></span>
              <span className="truncate text-caption text-fg-3">{rolesText(s)}</span>
            </span>
            {s.id === currentId && <Icon icon={CheckIcon} className="size-4 text-fg" />}
          </DropdownMenuItem>
        ))}
        {shown.length === 0 && <p role="status" className="px-2 py-2 text-body-sm text-fg-3">No space matches &ldquo;{find.trim()}&rdquo;.</p>}
      </DropdownMenuGroup>
      {onCreate && <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCreate}>Create space</DropdownMenuItem>
      </>}
      <DropdownMenuSeparator />
      <p className="px-2 py-1.5 text-caption text-fg-3">{SWITCHER_FOOTNOTE}</p>
    </div>
  );
}
