"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { ColumnsMenu, DataTable, FilterChecks, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { AlertsIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import type { BulkResult } from "@starterkit/shared/contracts/common";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { AGE_BUCKETS, BREAK_REASONS, BREAK_STATES, type BreakState } from "@starterkit/shared/recon";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { BREAKS, type BreakFilters, ENGINE_KEY, spaceDetail } from "@/lib/shared/queries";
import { AGE_LABEL, breakColumns, STATE_LABEL } from "./break-columns";

const AssignDialog = dynamic(() => import("./assign-dialog"), { ssr: false });

const FILTER_DEFAULTS: BreakFilters = { q: "", recon: "", reason: "", state: "", age: "", assignee: "" };
const ASSIGNEE_LABEL: Record<string, string> = { me: "Mine", none: "Unassigned" };
const FILTER_FIELDS = [
  { key: "q", label: "Search" },
  { key: "assignee", label: "Assignee", multiple: true, format: (v: string) => ASSIGNEE_LABEL[v] ?? v },
  { key: "state", label: "State", multiple: true, format: (v: string) => STATE_LABEL[v as BreakState] ?? v },
  { key: "reason", label: "Reason", multiple: true },
  { key: "age", label: "Age", multiple: true, format: (v: string) => AGE_LABEL[v as keyof typeof AGE_LABEL] ?? v },
] as const;
const OPEN_STATES = BREAK_STATES.filter((s) => s !== "resolved");
/** Why the API skipped breaks of a bulk action, in the words of that action. */
const SKIP_TEXT: Record<string, string> = { not_found: "no longer in the queue", forbidden: "someone else has them", invalid_state: "not in a state this action changes" };

/**
 * A space's breaks queue (Plan 5, spec §11): every break not resolved, oldest first, by assignee (Mine, Unassigned),
 * state, reason and age. A space admin or reviewer assigns the selected breaks; whoever works breaks takes them and
 * marks them investigating or pending external. Each action answers what it did and what it skipped.
 */
export function BreaksPage({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const def = useMemo(() => BREAKS(spaceId), [spaceId]);
  const t = useTableQuery<BreakRowDto, BreakFilters>(def);
  const f = t.state;
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: spaceDetail(spaceId).key, queryFn: () => api<SpaceRowDto>(spaceDetail(spaceId).url) }).data?.roles ?? [];
  const canAssign = roles.some((r) => r === "space_admin" || r === "reviewer");
  const canWork = canAssign || roles.includes("operator");
  // selection belongs to the rows on screen: another page, size, sort or filter starts empty
  const shown = `${f.page}|${f.pageSize}|${f.sort}|${t.filterQuery}`;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selectedOn, setSelectedOn] = useState(shown);
  if (selectedOn !== shown) { setSelectedOn(shown); setSelected(new Set()); }
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = t.rows;
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const allOn = selected.size > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = useCallback(() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id))), [allOn, rows]);
  const columns = useMemo(() => breakColumns(canWork ? { has: (id) => selected.has(id), toggle, all: { checked: allOn, count: rows.length, toggle: toggleAll } } : undefined),
    [canWork, selected, allOn, rows.length, toggleAll]);
  const filtered = Object.entries(f).some(([k, v]) => k in FILTER_DEFAULTS && v !== "");

  /** One bulk action over the selection: its answer as a toast (what it did, what it skipped and why). */
  async function act(label: string, path: "assign" | "take" | "state", body: object, verb: string) {
    setBusy(label);
    try {
      const r = await api<BulkResult>(`/api/spaces/${encodeURIComponent(spaceId)}/breaks/${path}`, { method: "POST", body: JSON.stringify({ ids: [...selected], ...body }) });
      const why = [...new Set(r.skipped.map((s) => SKIP_TEXT[s.code] ?? s.code))].join("; ");
      toast(`${verb} ${r.done.length === 1 ? "1 break" : `${r.done.length} breaks`}.`, r.skipped.length ? { description: `${r.skipped.length} skipped: ${why}.` } : undefined);
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ENGINE_KEY });
    } catch (e) {
      toast.error(errorText(e));
      throw e;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-section">
      <PageHeader title="Breaks" description="Items no pass paired by day close, and where each one stands." />
      <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the breaks; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: f.q, recon: f.recon, assignee: f.assignee, state: f.state, reason: f.reason, age: f.age }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) => <>
          <FilterSearch label="Search breaks" value={draft.q} onChange={(q) => patch({ q })} placeholder="Reference" />
          <FilterChecks label="Assignee" value={draft.assignee} options={[{ value: "me", label: "Mine" }, { value: "none", label: "Unassigned" }]} onChange={(assignee) => patch({ assignee })} />
          <FilterChecks label="State" value={draft.state} options={OPEN_STATES.map((s) => ({ value: s, label: STATE_LABEL[s] }))} onChange={(state) => patch({ state })} />
          <FilterChecks label="Reason" value={draft.reason} options={BREAK_REASONS.map((r) => ({ value: r, label: r }))} onChange={(reason) => patch({ reason })} />
          <FilterChecks label="Age" value={draft.age} options={AGE_BUCKETS.map((a) => ({ value: a, label: AGE_LABEL[a] }))} onChange={(age) => patch({ age })} />
        </>}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={AlertsIcon} title={`Breaks in ${spaceName}`} count={t.count} description={canWork ? "Select breaks to take, assign or mark them" : undefined}>
        {summary}
        {canWork && rows.length > 0 && (
          // on a phone, with breaks selected, the bar sticks under the top bar; from 768 px it shows only with a selection
          <div role="region" aria-label="Bulk actions" className={cn("flex min-h-12 flex-wrap items-center gap-2 border-b border-line bg-card px-3 py-2",
            selected.size > 0 ? "max-md:sticky max-md:top-(--topbar-h) max-md:z-20" : "md:hidden")}>
            <label className="flex items-center gap-2 text-body-sm text-fg-2">
              <input type="checkbox" className="size-4 cursor-pointer accent-primary" checked={allOn} onChange={toggleAll} />
              {selected.size > 0 ? `${selected.size} selected` : `Select all ${rows.length} on this page`}
            </label>
            {selected.size > 0 && <>
              <Button size="sm" variant="secondary" disabled={!!busy} aria-busy={busy === "take" || undefined} onClick={() => void act("take", "take", {}, "Took").catch(() => {})}>Take</Button>
              {canAssign && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setAssigning(true)}>Assign</Button>}
              <Button size="sm" variant="secondary" disabled={!!busy} aria-busy={busy === "investigating" || undefined}
                onClick={() => void act("investigating", "state", { state: "investigating" }, "Marked investigating:").catch(() => {})}>Mark investigating</Button>
              <Button size="sm" variant="secondary" disabled={!!busy} aria-busy={busy === "pending_external" || undefined}
                onClick={() => void act("pending_external", "state", { state: "pending_external" }, "Marked pending external:").catch(() => {})}>Mark pending external</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
            </>}
          </div>
        )}
        <DataTable label="Breaks" rowHeight="identity" columns={columns} hidden={t.hidden} rows={rows} rowKey={(r) => r.id} loading={t.loading}
          isSelected={(r) => selected.has(r.id)} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load breaks", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={filtered
            ? { icon: AlertsIcon, title: "No breaks match", description: "Change the filters, or clear them to see every break." }
            : { icon: AlertsIcon, title: "No breaks", description: "A break appears here when a recon closes a day with items no pass paired." }} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
      {assigning && (
        <AssignDialog spaceId={spaceId} count={selected.size} onClose={() => setAssigning(false)}
          onAssign={async (assigneeId) => { await act("assign", "assign", { assigneeId }, assigneeId ? "Assigned" : "Unassigned"); setAssigning(false); }} />
      )}
    </div>
  );
}
