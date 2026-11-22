"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState } from "react";
import { type Column, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, RelativeTime, StatusChip, Toolbar } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { BranchIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { LibraryDetailDto, LibraryRowDto } from "@starterkit/shared/contracts/workflows";
import { ROLE_LABEL } from "@starterkit/shared/spaces";
import { DEFAULT_LEVELS, type Level } from "@starterkit/shared/workflows";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { type LibraryFilters, WORKFLOWS } from "@/lib/shared/queries-recon";
import { LevelDots, newLevel } from "./levels-editor";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const FILTER_DEFAULTS: LibraryFilters = { q: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }] as const;

/** The built-in default chain as the list's first row, read only (audit §5.7): what a change without a workflow takes. */
export const DEFAULT_ROW_ID = "default";
const DEFAULT_ROW: LibraryRowDto = {
  id: DEFAULT_ROW_ID, name: "Default chain", levels: DEFAULT_LEVELS.length, levelNames: DEFAULT_LEVELS.map((l) => l.name), archived: false,
  published: null, open: null, reconsUsing: 0, updatedAt: "",
};
/** Who decides a chain, level by level: "one of Reviewer or Space admin" (the built-in chain's words, from DEFAULT_LEVELS). */
export const defaultChainText = (levels: readonly Level[] = DEFAULT_LEVELS) => levels.map((l) => l.groups.map((g) => {
  const need = g.need.kind === "any" ? "one" : g.need.kind === "all" ? "all" : String(g.need.n);
  return `${need} of ${g.spaceRoles.map((r) => ROLE_LABEL[r]).join(" or ")}`;
}).join(" and ")).join(", then ");
/**
 * The list's rows: the built-in chain leads the first page of the unsearched list once it has loaded workflows (it
 * isn't one of the space's, nor counted), so a space without any still shows No workflows yet.
 */
export const libraryRows = (rows: LibraryRowDto[], s: { q: string; page: number; failed: boolean }) =>
  !s.q && s.page === 1 && !s.failed && rows.length ? [DEFAULT_ROW, ...rows] : rows;
/** "Checker · Treasury head", or how many levels when they have no names. */
export const levelsText = (r: Pick<LibraryRowDto, "levels" | "levelNames">) => {
  const named = r.levelNames.filter((n) => n.trim());
  return named.length === r.levels && named.length ? named.join(" · ") : `${r.levels} ${r.levels === 1 ? "level" : "levels"}`;
};
const usedText = (n: number) => `${n} ${n === 1 ? "recon" : "recons"}`;
export const libraryColumns = (spaceId: string): Column<LibraryRowDto>[] => {
  const href = (r: LibraryRowDto) => `/spaces/${encodeURIComponent(spaceId)}/workflows/${encodeURIComponent(r.id)}`;
  const builtIn = (r: LibraryRowDto) => r.id === DEFAULT_ROW_ID;
  return [
    { key: "name", header: "Workflow", sortable: true, mobile: "title", className: "min-w-56", cell: (r) => (
      <span className="grid min-w-0">
        {builtIn(r) ? <span className="font-medium text-fg">{r.name}</span> : <Link href={href(r)} className={LINK}>{r.name}</Link>}
        {builtIn(r) ? <span className="text-caption text-fg-3">Built in · read only · {defaultChainText()}</span>
          : (r.open || r.archived) && <span className="text-caption text-fg-3">{r.archived ? "Archived" : r.open!.status === "in_review" ? `Version ${r.open!.version} waits for approval` : `Draft ${r.open!.version}`}</span>}
      </span>
    ) },
    { key: "levels", header: "Levels", mobile: "meta", className: "min-w-40", cell: (r) => (
      <span className="flex min-w-0 items-center gap-2"><LevelDots n={Math.max(1, r.levels)} muted={!r.published && !builtIn(r)} /><span className="truncate" title={levelsText(r)}>{levelsText(r)}</span></span>
    ) },
    { key: "live", header: "Live", mobile: "meta", className: "whitespace-nowrap", cell: (r) => (builtIn(r) ? <StatusChip health="healthy" label="Always" />
      : r.published ? <StatusChip health="healthy" label={`Version ${r.published.version}`} /> : <StatusChip health="stopped" label="Not live" />) },
    { key: "usedBy", header: "Used by", mobile: "meta", cell: (r) => (builtIn(r) ? <span className="text-fg-3">Changes without a workflow</span>
      : r.reconsUsing ? <Link href={`${href(r)}#used-by`} className={LINK}>{usedText(r.reconsUsing)}</Link> : <span className="text-fg-3">Not used</span>) },
    { key: "updatedAt", header: "Changed", mobile: "meta", className: "whitespace-nowrap", cell: (r) => (r.updatedAt ? <RelativeTime at={Date.parse(r.updatedAt)} /> : <span className="text-fg-3">—</span>) },
  ];
};

/**
 * A space's workflows (DEC-052 rev 2 §4.1): named chains of levels that the space's recons pin for a change.
 * New workflow saves a draft at once and opens it, so nothing typed is lost.
 */
export function LibraryPage({ spaceId, spaceName, canManage }: { spaceId: string; spaceName: string; canManage: boolean }) {
  const router = useRouter();
  const def = useMemo(() => WORKFLOWS(spaceId), [spaceId]);
  const COLUMNS = useMemo(() => libraryColumns(spaceId), [spaceId]);
  const t = useTableQuery<LibraryRowDto, LibraryFilters>(def);
  const [busy, setBusy] = useState(false);
  const rows = libraryRows(t.rows, { q: t.state.q, page: t.state.page, failed: !!t.loadError });
  async function create() {
    setBusy(true);
    try {
      // "New workflow", else the next free "New workflow N" (names are unique); renamed in the editor
      for (let n = 1; ; n++) {
        const name = n === 1 ? "New workflow" : `New workflow ${n}`;
        const w = await api<LibraryDetailDto>(`/api/spaces/${encodeURIComponent(spaceId)}/workflows`, { method: "POST", body: JSON.stringify({ spec: { name, levels: [newLevel()] } }) })
          .catch((e: unknown) => { if (n < 20 && (e as { code?: string }).code === "duplicate") return null; throw e; });
        if (w) { router.push(`/spaces/${encodeURIComponent(spaceId)}/workflows/${encodeURIComponent(w.id)}`); return; }
      }
    } catch (e) { toast.error(errorText(e)); setBusy(false); }
  }
  return (
    <div className="grid gap-section">
      <PageHeader title="Workflows" description={`Approval chains, level by level, that the recons of ${spaceName} use for changes that need approval.`}
        actions={canManage ? <Button type="button" onClick={() => void create()} disabled={busy} aria-busy={busy || undefined}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}New workflow</Button> : undefined} />
      <FilterSurface>
        {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the workflows; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
        <FilterLayout busy={t.paging.busy} values={{ q: t.state.q }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS} onApply={(values, options) => t.set(values, options)}
          filters={(draft, patch) => <FilterSearch label="Search workflows" value={draft.q} onChange={(q) => patch({ q })} placeholder="Name" />}>
          {({ summary }) => (
            <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={COLUMNS} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
              flush icon={BranchIcon} title="All workflows" count={t.count}>
              {summary}
              <DataTable label="Workflows" columns={COLUMNS} hidden={t.hidden} rows={rows} rowKey={(r) => r.id} loading={t.loading}
                sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
                error={t.loadError ? { title: "Couldn't load workflows", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
                empty={t.state.q
                  ? { icon: BranchIcon, title: "No workflows match", description: "Change the search, or clear it to see every workflow." }
                  : { icon: BranchIcon, title: "No workflows yet", description: `A workflow appears here once a space admin creates one. Until a recon uses one, its changes take the built-in default chain: ${defaultChainText()}.` }} />
            </Panel>
          )}
        </FilterLayout>
      </FilterSurface>
    </div>
  );
}
