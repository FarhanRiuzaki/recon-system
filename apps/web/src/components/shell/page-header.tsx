"use client";

import { BlockedButton, verbVariant } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@starterkit/ui/ui/dropdown-menu";
import { Icon } from "@starterkit/ui/ui/icon";
import { MoreIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { type TrailCrumb, usePublishTrail } from "@/lib/client/crumb-trail";

/**
 * What a destructive header action asks before it runs (copy guide "Confirmations"): the title names the action and
 * the record, the description and `impact` say what happens; the confirm button repeats the action (`actionLabel`,
 * the item's label by default). A failure stays in the dialog.
 */
export type HeaderConfirm = { title: string; description: string; impact?: string[]; actionLabel?: string; onConfirm: () => Promise<void> };
type Base = { label: string; reason?: string | null; busy?: boolean };
/**
 * A secondary header action: a link (`href`) or a command (`onSelect`); `reason` blocks it and says why; `busy` while
 * it runs. A destructive one (deletes, deactivates, revokes, resets, retires: ui-standard §1a) is always an item of the
 * ⋯ menu, at every width, and runs only through its confirmation: `confirm` (the shared dialog) or, when the
 * confirmation asks for more than a yes (Turn off connector asks why), `onSelect` opening the caller's own dialog,
 * whose `onCloseAutoFocus` is `returnToMore`.
 */
export type HeaderAction = PlainAction | DestructiveAction;
type DestructiveAction = Base & { destructive: true } & ({ confirm: HeaderConfirm; onSelect?: never } | { confirm?: never; onSelect: () => void });
type Confirmed = Extract<DestructiveAction, { confirm: HeaderConfirm }>;
/** A header action that is not destructive: a link or a command. */
export type PlainAction = Base & { destructive?: false; href?: string; onSelect?: () => void };

/**
 * A dialog opened from a ⋯ item returns focus to the ⋯ trigger when it closes (pass as `onCloseAutoFocus`): the item it
 * came from is gone with the menu, and Radix would otherwise drop focus on the body.
 */
export function returnToMore(e: Event) {
  const more = document.querySelector<HTMLElement>("[data-slot=page-header] [data-more-actions]");
  if (!more) return;
  e.preventDefault();
  more.focus();
}

/** From 768 px: a non-destructive action as a secondary button (its verb's intent: Edit … blue), a BlockedButton when a rule blocks it. */
function ActionButton({ a }: { a: HeaderAction }) {
  if (a.destructive) return null;
  const variant = verbVariant(a.label, "secondary");
  if (a.href && !a.reason) return <Button asChild variant={variant}><Link href={a.href}>{a.label}</Link></Button>;
  return (
    <BlockedButton variant={variant} reason={a.reason ?? null} disabled={a.busy} aria-busy={a.busy || undefined} onClick={a.onSelect}>
      {a.busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{a.label}
    </BlockedButton>
  );
}

/**
 * The "More actions" menu (a deferred overlay), last in the header: below 768 px every action, from 768 px only the
 * destructive ones (the others are buttons there). A blocked or running item is off, with its reason.
 */
function MoreMenu({ actions, onConfirm }: { actions: HeaderAction[]; onConfirm: (a: Confirmed) => void }) {
  const danger = actions.some((a) => a.destructive);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="icon" aria-label="More actions" data-more-actions className={danger ? undefined : "md:hidden"}><Icon icon={MoreIcon} /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {[...actions.filter((a) => !a.destructive), ...actions.filter((a) => a.destructive)].map((a) => {
          const off = !!a.reason || !!a.busy;
          const body = <span className="grid min-w-0"><span>{a.label}</span>{a.reason && <span className="text-caption text-fg-3">{a.reason}</span>}</span>;
          if (a.destructive) return <DropdownMenuItem key={a.label} disabled={off} onSelect={() => (a.confirm ? onConfirm(a) : a.onSelect?.())} variant="destructive">{body}</DropdownMenuItem>;
          return a.href && !off
            ? <DropdownMenuItem key={a.label} asChild className="md:hidden"><Link href={a.href}>{body}</Link></DropdownMenuItem>
            : <DropdownMenuItem key={a.label} disabled={off} onSelect={a.onSelect} className="md:hidden">{body}</DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Page header (ui-standard §1): `title-1` title, optional status next to it, actions right (one primary action),
 * one sentence of scope under the title. On a sub-page the title is also the top bar breadcrumb's last crumb, after the
 * nav page and any parents in `trail` ("Users / Rina Wulandari / Edit user"). Title and description wrap (a long
 * name or email breaks anywhere rather than widening the page). `actions` stay visible at every width; `more`
 * (secondary actions) follow them as buttons from 768 px and fold into a "More actions" menu below, both in the server
 * HTML and switched by CSS. A destructive `more` action is in that menu at every width and opens its confirmation.
 */
export function PageHeader({ title, crumb, status, actions, more, description, trail = [] }: {
  title: string;
  /** The breadcrumb's last crumb when it differs from the title (a version page: "Version 2" under "{name} · version 2"). */
  crumb?: string; status?: ReactNode; actions?: ReactNode; more?: HeaderAction[]; description?: ReactNode; trail?: TrailCrumb[];
}) {
  usePublishTrail(usePathname(), [...trail, { label: crumb ?? title }]);
  const extra = more?.length ? more : null;
  const [asking, setAsking] = useState<Confirmed | null>(null);
  return (
    <header data-slot="page-header" className="flex flex-wrap items-start gap-x-3 gap-y-3">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 tabIndex={-1} className="min-w-0 text-title-1 wrap-anywhere text-fg">{title}</h1>
          {status}
        </div>
        {description && <div className="max-w-[72ch] text-body-sm wrap-anywhere text-fg-3">{description}</div>}
      </div>
      {(actions || extra) && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
          {extra && <>
            <div className="contents max-md:hidden">{extra.map((a) => <ActionButton key={a.label} a={a} />)}</div>
            <MoreMenu actions={extra} onConfirm={setAsking} />
          </>}
        </div>
      )}
      {asking && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setAsking(null); }} auditFields={false} reasons={[]} destructive
          title={asking.confirm.title} description={asking.confirm.description} impact={asking.confirm.impact ?? []}
          actionLabel={asking.confirm.actionLabel ?? asking.label} onConfirm={async () => asking.confirm.onConfirm()} onCloseAutoFocus={returnToMore} />
      )}
    </header>
  );
}
