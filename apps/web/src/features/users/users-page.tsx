"use client";

import { selectionValues } from "@starterkit/shared/filter-selection";
import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { ActionMenu, ColumnsMenu, DataTable, FilterLayout, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { formatNumber } from "@starterkit/ui/lib/format";
import { HEALTH } from "@starterkit/ui/lib/status";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { ActiveUserIcon, AddIcon, ErrorIcon, KeyIcon, UsersIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";
import { useTableQuery } from "@/lib/client/use-table-query";
import type { UserRowDto } from "@starterkit/shared/contracts/users";
import { BULK_ALL_MAX } from "@/lib/shared/bulk";
import { USER_STATUSES, type UserFilters, USERS } from "@/lib/shared/queries";
import type { Pending } from "./users-action-dialog";
import { userColumns } from "./user-columns";
import { patchUserCache, USERS_KEY, protection, rankBlock, useLastSuperadminId, useRoleNames } from "./use-users";
import { statusTone } from "@/lib/shared/categories";

const FILTER_DEFAULTS: UserFilters = { q: "", role: "", status: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }, { key: "role", label: "Role", multiple: true }, { key: "status", label: "Status", multiple: true, format: (value: string) => value === "active" ? "Active" : "Inactive" }] as const;
/** The table names the view it shows, as the sidebar's Users children do (the page bar already says "Users"). */
const VIEW_TITLE: Record<(typeof USER_STATUSES)[number], string> = { "": "All users", active: "Active users", inactive: "Inactive users" };
const LEGEND = [{ health: statusTone("active"), label: "Active", description: "Can sign in." }, { health: statusTone("inactive"), label: "Inactive", description: HEALTH.stopped.description }];

/**
 * The confirm dialog is opened on click only: its own chunk, out of the route's first load (AGENTS.md §9). The import
 * starts on the first press or focus in the page (intent), so it is there by the time a dialog opens.
 */
const loadDialog = () => import("./users-action-dialog");
const UsersActionDialog = dynamic(() => loadDialog().then((m) => m.UsersActionDialog), { ssr: false });
const preloadDialog = () => void loadDialog();

const UsersFilters = dynamic(() => import("./users-filters").then(m => m.UsersFilters), {
  ssr: false, // rendered only inside the filter panel, which loads in the browser on open
  loading: () => <div role="status" className="grid gap-4"><span className="sr-only">Loading filter fields…</span><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-20" /></div>,
});

export function UsersPage() {
  const { user: me, perms, can } = useAuth();
  const qc = useQueryClient();
  const router = useRouter();
  const t = useTableQuery<UserRowDto, UserFilters>(USERS);
  const f = t.state;
  const roles = useRoleNames();
  const lastSuperId = useLastSuperadminId();
  // Selection belongs to the rows on screen: another page, size, sort or filter starts empty.
  const shown = `${f.page}|${f.pageSize}|${f.sort}|${t.filterQuery}`;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // "Select all N users" (Polaris, Carbon): every user the search and filters match, not only this page's rows.
  const [everyMatch, setEveryMatch] = useState(false);
  const [selectedOn, setSelectedOn] = useState(shown);
  if (selectedOn !== shown) { setSelectedOn(shown); setSelected(new Set()); setEveryMatch(false); }
  const [pending, setPending] = useState<Pending | null>(null);
  const [role, setRole] = useState("");
  const [changing, setChanging] = useState<string | null>(null);

  const rows = t.rows;
  const canAct = can("user.edit") || can("user.delete");
  const filtered = f.q !== "" || f.role !== "" || f.status !== "";
  const set = t.set;
  const toggle = (id: string) => { setEveryMatch(false); setSelected((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; }); };
  const allOn = selected.size > 0 && rows.every((u) => selected.has(u.id));
  const toggleAll = useCallback(() => { setEveryMatch(false); setSelected(allOn ? new Set() : new Set(rows.map((u) => u.id))); }, [allOn, rows]);
  const total = t.total ?? 0;
  const columns = useMemo(() => userColumns(canAct ? { has: (id) => selected.has(id), toggle, all: { checked: allOn, count: rows.length, toggle: toggleAll } } : undefined),
    [canAct, selected, allOn, rows.length, toggleAll]);

  const refresh = () => qc.invalidateQueries({ queryKey: USERS_KEY });

  async function confirm() {
    const p = pending!;
    if (p.kind === "one" && p.action === "deactivate") { await setStatus(p.user, false, true); return; }
    await (await loadDialog()).confirmUserAction(p, role);
    if (p.kind === "bulk") { setSelected(new Set()); setEveryMatch(false); }
    await refresh();
  }

  // Deactivating confirms first (row ⋯ menu, ui-standard §1a); activating runs at once. The result toast offers Undo.
  // Optimistic: the row's status changes at once and goes back if the server refuses (in the dialog: its error there).
  async function setStatus(u: UserRowDto, active: boolean, inDialog = false) {
    setChanging(u.id);
    const restore = await patchUserCache(qc, u.id, { isActive: active });
    try {
      await api(`/api/users/${u.id}/status`, { method: "POST", body: JSON.stringify({ active }) });
      if (active) toast(`Activated ${u.name}.`);
      else toast.undo(`Deactivated ${u.name}.`, () => void setStatus(u, true), { description: "Their sessions ended. Undo lets them sign in again." });
    } catch (e) { restore(); if (inDialog) throw e; toast.error(errorText(e)); }
    finally { setChanging(null); void refresh(); }
  }

  const ids = [...selected];
  // What a bulk button acts on: the picked rows, or every match ("Select all N users"; the list's own search and filters).
  const scope = everyMatch
    ? { ids: [], count: total, filter: { ...(f.q ? { q: f.q } : {}), ...(f.role ? { role: selectionValues(f.role) } : {}), ...(f.status ? { status: selectionValues(f.status) } : {}) } }
    : { ids, count: ids.length };

  return (
    <div className="grid gap-section" onPointerDown={preloadDialog} onFocus={preloadDialog}>
      <PageHeader title="Users" description="Accounts that can sign in, their roles and status."
        actions={can("user.create") ? <Button variant="create-solid" asChild><Link href="/users/new"><Icon icon={AddIcon} />Create user</Link></Button> : undefined} />
      <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the users; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: f.q, role: f.role, status: f.status }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS}
        onApply={(values, options) => set(values, options)} description="Narrow this list to the people you need."
        filters={(draft, patch) => <UsersFilters draft={draft} patch={patch} facets={t.facets} />}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={UsersIcon} title={VIEW_TITLE[(selectionValues(f.status).length === 1 ? selectionValues(f.status)[0] : "") as keyof typeof VIEW_TITLE]} count={t.count} description="Select rows for bulk actions" legend={LEGEND}>
        {summary}
        {canAct && rows.length > 0 && (
          // On a phone, with rows selected, the bar sticks under the top bar so the actions stay in reach while scrolling the cards.
          // From 768 px it shows only with a selection (the header checkbox selects the page); a phone has no header row.
          <div role="region" aria-label="Bulk actions" className={cn("flex min-h-12 flex-wrap items-center gap-2 border-b border-line bg-card px-3 py-2",
            selected.size > 0 ? "max-md:sticky max-md:top-(--topbar-h) max-md:z-20" : "md:hidden")}>
            <label className="flex items-center gap-2 text-body-sm text-fg-2">
              <input type="checkbox" className="size-4 cursor-pointer accent-primary" checked={allOn} onChange={toggleAll} />
              {everyMatch ? `All ${formatNumber(total)} selected` : selected.size > 0 ? `${selected.size} selected` : `Select all ${rows.length} on this page`}
            </label>
            {allOn && total > rows.length && (everyMatch
              ? <Button size="sm" variant="link" className="mx-1" onClick={() => setEveryMatch(false)}>Select this page only</Button>
              : total <= BULK_ALL_MAX
                ? <Button size="sm" variant="link" className="mx-1" onClick={() => setEveryMatch(true)}>Select all {formatNumber(total)} users</Button>
                : <span className="text-caption text-fg-3">Up to {formatNumber(BULK_ALL_MAX)} users at a time. Narrow the search or filters to select them all.</span>)}
            {selected.size > 0 && <>
              {can("user.edit") && <>
                <Button size="sm" variant="secondary" onClick={() => setPending({ kind: "bulk", action: "activate", ...scope })}><Icon icon={ActiveUserIcon} />Activate</Button>
                <Button size="sm" variant="caution" onClick={() => setPending({ kind: "bulk", action: "deactivate", ...scope })}><Icon icon={ErrorIcon} />Deactivate</Button>
                <Button size="sm" variant="secondary" onClick={() => { setRole(roles.more ? "" : roles.names[0] ?? ""); setPending({ kind: "bulk", action: "assignRole", ...scope }); }}><Icon icon={KeyIcon} />Assign role</Button>
              </>}
              {can("user.delete") && <Button size="sm" variant="destructive" onClick={() => setPending({ kind: "bulk", action: "delete", ...scope })}>Delete</Button>}
              <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setEveryMatch(false); }}>Clear selection</Button>
            </>}
          </div>
        )}
        <DataTable label="Users" rowHeight="identity" columns={columns} hidden={t.hidden} rows={rows} rowKey={(u) => u.id} loading={t.loading}
          isSelected={(u) => selected.has(u.id)} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load users", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={filtered
            ? { icon: UsersIcon, title: "No users match", description: "Change the search or filters, or clear them to see every user." }
            : { icon: UsersIcon, title: "No users yet", description: "Users appear here after you create them." }}
          rowActions={(u) => {
            const block = protection(u, me.id, perms, lastSuperId);
            const rank = rankBlock(u, perms);
            // Every row action is an item of the row's ⋯ menu, each with its reason when blocked (ui-standard §1a).
            const busy = changing === u.id;
            // While the change runs the row already shows its new status (optimistic): the item keeps naming the action in flight.
            const wasActive = busy ? !u.isActive : u.isActive;
            return <ActionMenu label={`Actions for ${u.name}`} actions={[
              { id: "open", label: "View user", onSelect: () => router.push(`/users/${u.id}`) },
              ...(can("user.edit") ? [{ id: "edit", label: "Edit user", disabled: !!rank, hint: rank ?? undefined, onSelect: () => router.push(`/users/${u.id}/edit`) }] : []),
              ...(can("user.edit") ? [wasActive
                ? { id: "status", label: busy ? "Deactivating…" : "Deactivate user", destructive: true, disabled: !!block || busy, hint: block ?? undefined, onSelect: () => setPending({ kind: "one", action: "deactivate", user: u }) }
                : { id: "status", label: busy ? "Activating…" : "Activate user", disabled: !!rank || busy, hint: rank ?? undefined, onSelect: () => void setStatus(u, true) }] : []),
              ...(can("user.delete") ? [{ id: "delete", label: "Delete user", destructive: true, disabled: !!block, hint: block ?? undefined, onSelect: () => setPending({ kind: "one", action: "delete", user: u }) }] : []),
            ]} />;
          }} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
      {pending && <UsersActionDialog pending={pending} role={role} onRole={setRole} roles={roles} onClose={() => setPending(null)} onConfirm={confirm} />}
    </div>
  );
}
