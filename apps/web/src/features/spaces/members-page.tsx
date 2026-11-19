"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ActionMenu, activeElement, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, focusBack, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { HEALTH } from "@starterkit/ui/lib/status";
import { Button } from "@starterkit/ui/ui/button";
import { UsersIcon } from "@starterkit/ui/ui/icons";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";
import { useTableQuery } from "@/lib/client/use-table-query";
import type { SpaceMemberDto } from "@starterkit/shared/contracts/spaces";
import { LAST_SPACE_ADMIN, SOURCE_ADMIN_REASON } from "@starterkit/shared/spaces";
import { activityInvestigationHref } from "@/lib/shared/activity-links";
import { SPACE_MEMBERS } from "@/lib/shared/queries";
import { MEMBER_COLUMNS } from "./member-columns";
import { RoleMatrix } from "./role-matrix";
import { useSpace } from "./use-spaces";

/** The member dialogs load on click, outside the page's first load (route budget, AGENTS.md §9); the import starts on the first press or focus in the page. */
const loadDialogs = () => import("./member-dialogs");
const AddMemberDialog = dynamic(() => loadDialogs().then((m) => m.AddMemberDialog), { ssr: false });
const ChangeRolesDialog = dynamic(() => loadDialogs().then((m) => m.ChangeRolesDialog), { ssr: false });
const RemoveMemberDialog = dynamic(() => loadDialogs().then((m) => m.RemoveMemberDialog), { ssr: false });
const preloadDialogs = () => void loadDialogs();

const FILTER_DEFAULTS = { q: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }] as const;
const LEGEND = (["healthy", "stopped"] as const).map((h) => ({ health: h, label: h === "healthy" ? "Active" : "Inactive", description: h === "healthy" ? "Can sign in." : HEALTH.stopped.description }));

/**
 * A space's members (page.tsx has checked the viewer may open the space and prefetched it with the first page) and
 * the read-only role matrix. A space admin of this space, or a holder of space.manage, also sees Add member and the row
 * actions Change roles and Remove from space; only a space.manage holder may grant or remove Source admin.
 */
export function MembersPage({ id }: { id: string }) {
  const { can, user } = useAuth();
  const router = useRouter();
  const space = useSpace(id).data;
  const t = useTableQuery<SpaceMemberDto, { q: string }>(SPACE_MEMBERS(id));
  const name = space?.name ?? "";
  const canSourceAdmin = can("space.manage");
  const manage = canSourceAdmin || !!space?.roles.includes("space_admin");
  type Open = { kind: "add" } | { kind: "roles" | "remove"; member: SpaceMemberDto };
  const [dialog, setDialog] = useState<Open | null>(null);
  // Focus goes back to what opened the dialog: the row's menu button (its item is gone by then) or Add member; the
  // page's h1 when that row was removed.
  const origin = useRef<HTMLElement | null>(null);
  const open = (d: Open) => {
    origin.current = document.querySelector<HTMLElement>('[data-slot="action-menu-trigger"][aria-expanded="true"]') ?? activeElement();
    setDialog(d);
  };
  const close = () => setDialog(null);
  const returnFocus = () => focusBack(origin.current);
  // ponytail: the only active space admin is known only while the table holds every member (no search, one page);
  // otherwise nothing is locked here and the API's 409 last_space_admin shows in the dialog. A role filter on the
  // members API would lift that ceiling.
  const complete = !t.state.q && !t.totalCapped && t.rows.length === t.total;
  const activeAdmin = (m: SpaceMemberDto) => m.active && m.roles.includes("space_admin");
  const lastAdmin = (m: SpaceMemberDto) => complete && activeAdmin(m) && !t.rows.some((o) => o.userId !== m.userId && activeAdmin(o));
  /** Why "Remove from space" is off for `m`, or null. */
  const removeBlocked = (m: SpaceMemberDto) => (lastAdmin(m) ? LAST_SPACE_ADMIN : !canSourceAdmin && m.roles.includes("source_admin") ? SOURCE_ADMIN_REASON : null);

  return (
    <div className="grid gap-section" onPointerDown={manage ? preloadDialogs : undefined} onFocus={manage ? preloadDialogs : undefined}>
      <PageHeader title="Members" trail={name ? [{ label: name }] : []}
        description={`People who can work in the ${name} space and what each of them may do. A person can hold several roles.`}
        actions={manage ? <Button onClick={() => open({ kind: "add" })}>Add member</Button> : undefined} />
      <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the members; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: t.state.q }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) =>
          <FilterSearch label="Search members" value={draft.q} onChange={q => patch({ q })} placeholder="Name or username" />}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={MEMBER_COLUMNS} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={UsersIcon} title={`Members of ${name}`} count={t.count} legend={LEGEND}>
        {summary}
        <DataTable label="Members" rowHeight="identity" columns={MEMBER_COLUMNS} hidden={t.hidden} rows={t.rows} rowKey={(m) => m.userId} loading={t.loading}
          sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load members", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={t.state.q
            ? { icon: UsersIcon, title: "No members match", description: "Change the search, or clear it to see every member." }
            : { icon: UsersIcon, title: "No members yet", description: "Members appear here after a space admin adds them." }}
          rowActions={can("audit.view") || manage ? (m) => {
            const blocked = removeBlocked(m);
            return (
              <ActionMenu label={`Actions for ${m.name}`} actions={[
                ...(can("audit.view") ? [{ id: "activity", label: "View activity", onSelect: () => router.push(activityInvestigationHref("range=90d", { actorId: m.userId })) }] : []),
                ...(manage ? [
                  { id: "roles", label: "Change roles", onSelect: () => open({ kind: "roles", member: m }) },
                  { id: "remove", label: "Remove from space", destructive: true, disabled: !!blocked, hint: blocked ?? undefined, onSelect: () => open({ kind: "remove", member: m }) },
                ] : []),
              ]} />
            );
          } : undefined} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
      <RoleMatrix />
      {space && dialog?.kind === "add" && <AddMemberDialog space={space} canSourceAdmin={canSourceAdmin} onClose={close} returnFocus={returnFocus} />}
      {space && dialog?.kind === "roles" && (
        <ChangeRolesDialog space={space} member={dialog.member} canSourceAdmin={canSourceAdmin} lockedSpaceAdmin={lastAdmin(dialog.member)} onClose={close} returnFocus={returnFocus} />
      )}
      {space && dialog?.kind === "remove" && (
        // Removing yourself ends your access to this space: go where /spaces sends you next.
        <RemoveMemberDialog space={space} member={dialog.member} onClose={close} onRemoved={() => { if (dialog.member.userId === user.id) router.push("/spaces"); }} returnFocus={returnFocus} />
      )}
    </div>
  );
}
