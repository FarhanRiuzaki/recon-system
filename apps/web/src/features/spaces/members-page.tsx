"use client";

import { useRouter } from "next/navigation";
import { ActionMenu, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { HEALTH } from "@starterkit/ui/lib/status";
import { UsersIcon } from "@starterkit/ui/ui/icons";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";
import { useTableQuery } from "@/lib/client/use-table-query";
import type { SpaceMemberDto } from "@starterkit/shared/contracts/spaces";
import { activityInvestigationHref } from "@/lib/shared/activity-links";
import { SPACE_MEMBERS } from "@/lib/shared/queries";
import { MEMBER_COLUMNS } from "./member-columns";
import { RoleMatrix } from "./role-matrix";
import { useSpace } from "./use-spaces";

const FILTER_DEFAULTS = { q: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }] as const;
const LEGEND = (["healthy", "stopped"] as const).map((h) => ({ health: h, label: h === "healthy" ? "Active" : "Inactive", description: h === "healthy" ? "Can sign in." : HEALTH.stopped.description }));

/**
 * A space's members (page.tsx has checked the viewer may open the space and prefetched it with the first page) and
 * the read-only role matrix. Add member, Change roles and Remove from space come with their dialogs (Plan 1b Task 5).
 */
export function MembersPage({ id }: { id: string }) {
  const { can } = useAuth();
  const router = useRouter();
  const space = useSpace(id).data;
  const t = useTableQuery<SpaceMemberDto, { q: string }>(SPACE_MEMBERS(id));
  const name = space?.name ?? "";

  return (
    <div className="grid gap-section">
      <PageHeader title="Members" trail={name ? [{ label: name }] : []}
        description={`People who can work in the ${name} space and what each of them may do. A person can hold several roles.`} />
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
          rowActions={can("audit.view") ? (m) => (
            <ActionMenu label={`Actions for ${m.name}`} actions={[
              { id: "activity", label: "View activity", onSelect: () => router.push(activityInvestigationHref("range=90d", { actorId: m.userId })) },
            ]} />
          ) : undefined} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
      <RoleMatrix />
    </div>
  );
}
