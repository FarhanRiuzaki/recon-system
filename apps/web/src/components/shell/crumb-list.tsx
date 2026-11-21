"use client";

import Link from "next/link";
import { cn } from "@starterkit/ui/lib/cn";
import type { Crumb } from "@/lib/shared/nav";
import { NavGlyph } from "./nav-icon";

/**
 * The top bar's breadcrumb items (Captain): the first crumb (the nav page) and the last (the open page) stay whole;
 * only the crumbs between them shorten with "…" when the bar is narrow. The last keeps a half-bar cap so an outsized
 * record name can't push the bar's controls out. `sub` = a sub-page, where the nav page links back; `navHref` = the nav
 * page's remembered link. Phone: the nav page only.
 */
export function CrumbList({ items, sub, navHref }: { items: readonly Crumb[]; sub: boolean; navHref: (href: string) => string }) {
  return (
    <ol className="flex min-w-0 items-center gap-2 text-body text-fg-2">
      {items.map((c, i, all) => {
        // The open page is plain text: the nav page itself, or the trail's last crumb on a sub-page (/users/<id>),
        // where the nav page and any parents link back. Phone: the nav page only (the bar's title, in the server
        // HTML); the trail arrives after hydration and would swap the title.
        const last = i === all.length - 1 && !(sub && i === 0);
        const edge = i === 0 || i === all.length - 1;
        // first: never shorter; last: whole up to half the bar; between: shorten first
        const fit = i === 0 ? "whitespace-nowrap" : "truncate";
        return (
          <li key={`${c.label}-${i}`} data-crumb={edge ? "whole" : "short"}
            className={cn("inline-flex items-center gap-2", i === 0 ? "shrink-0" : edge ? "min-w-0 max-w-1/2 shrink-0" : "min-w-0", i > 0 && "max-md:hidden")}>
            {i > 0 && <span aria-hidden="true" className="text-fg-4">/</span>}
            {c.icon && <NavGlyph icon={c.icon} className="size-4 shrink-0 text-fg-3" />}
            {last
              ? <span aria-current="page" className={cn("font-medium text-fg", fit)}>{c.label}</span>
              : c.href ? <Link href={i === 0 ? navHref(c.href) : c.href} className={cn("rounded-xs hover:text-fg", fit)}>{c.label}</Link> : <span className={fit}>{c.label}</span>}
          </li>
        );
      })}
    </ol>
  );
}
