"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { ColumnsMenu, DataTable, Field, FilterChecks, FilterGroup, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AlertsIcon, AssignIcon, CheckIcon, InvestigateIcon, TakeIcon, WaitIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { toast } from "@starterkit/ui/ui/toast";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import type { BulkResult, Page } from "@starterkit/shared/contracts/common";
import type { ReconRowDto } from "@starterkit/shared/contracts/recon";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { AGE_BUCKETS, BREAK_REASONS, BREAK_STATES, type BreakState } from "@starterkit/shared/recon";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { majorAmount } from "@/lib/shared/amount";
import { ENGINE_KEY, spaceDetail } from "@/lib/shared/queries";
import { BREAKS, type BreakFilters, reconOptions as reconOptionsQuery } from "@/lib/shared/queries-recon";
import { breakColumns } from "./break-columns";
import { AGE_LABEL, STATE_LABEL } from "@/components/unmatch/break-model";
import { BreakSummary } from "./break-summary";
import { withCounts } from "@/lib/shared/table-state";
import { selectionState } from "@starterkit/shared/filter-selection";

const AssignDialog = dynamic(() => import("./assign-dialog"), { ssr: false });

const FILTER_DEFAULTS: BreakFilters = { q: "", recon: "", reason: "", state: "", age: "", assignee: "", amountMin: "", amountMax: "", checked: "" };
const ASSIGNEE_LABEL: Record<string, string> = { me: "Mine", none: "Unassigned" };
const CHECKED_LABEL: Record<string, string> = { yes: "Yes", no: "No" };
/** The quick filter "Mine or unassigned" (the queue's default stays every open item: a ruling of Batch 8). */
const MINE_OR_NONE = selectionState(["me", "none"]);
const filterFields = (reconName: (id: string) => string) => [
  { key: "q", label: "Search" },
  { key: "recon", label: "Recon", multiple: true, format: reconName },
  { key: "assignee", label: "Assignee", multiple: true, format: (v: string) => ASSIGNEE_LABEL[v] ?? v },
  { key: "state", label: "State", multiple: true, format: (v: string) => STATE_LABEL[v as BreakState] ?? v },
  { key: "reason", label: "Reason", multiple: true },
  { key: "age", label: "Age", multiple: true, format: (v: string) => AGE_LABEL[v as keyof typeof AGE_LABEL] ?? v },
  { key: "checked", label: "Checked again", multiple: true, format: (v: string) => CHECKED_LABEL[v] ?? v },
  { key: "amountMin", label: "Amount from" },
  { key: "amountMax", label: "Amount up to" },
] as const;
const OPEN_STATES = BREAK_STATES.filter((s) => s !== "resolved");
/** Why the API skipped breaks of a bulk action, in the words of that action. */
const SKIP_TEXT: Record<string, string> = { not_found: "no longer in the queue", forbidden: "someone else has them", invalid_state: "not in a state this action changes" };

/**
 * A space's breaks queue (Plan 5, spec §11): every break not resolved, oldest first, by assignee (Mine, Unassigned),
 * state, reason and age. A space admin or reviewer assigns the selected breaks; whoever works breaks takes them and
 * marks them investigating or pending external. Each action answers what it did and what it skipped.
 */
export function BreaksPage({ spaceId }: { spaceId: string }) {
  const def = useMemo(() => BREAKS(spaceId), [spaceId]);
  const t = useTableQuery<BreakRowDto, BreakFilters>(def);
  const f = t.state;
  const qc = useQueryClient();
  // the space's recons by name, for the Recon filter (a space keeps far fewer than 100 recons)
  const ro = reconOptionsQuery(spaceId);
  const recons = useQuery({ queryKey: ro.key, queryFn: () => api<Page<ReconRowDto>>(ro.url) }).data?.items;
  const reconOptions = useMemo(() => (recons ?? []).map((r) => ({ value: r.id, label: r.name })), [recons]);
  const fields = useMemo(() => filterFields((id) => recons?.find((r) => r.id === id)?.name ?? "A recon"), [recons]);
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
  const columns = useMemo(() => breakColumns(spaceId, canWork ? { has: (id) => selected.has(id), toggle, all: { checked: allOn, count: rows.length, toggle: toggleAll } } : undefined),
    [spaceId, canWork, selected, allOn, rows.length, toggleAll]);
  const filtered = Object.entries(f).some(([k, v]) => k in FILTER_DEFAULTS && v !== "");
  const mineOrNone = f.assignee === MINE_OR_NONE;

  /** One bulk action over the selection: its answer as a toast (what it did, what it skipped and why). */
  async function act(label: string, path: "assign" | "take" | "state", body: object, verb: string) {
    setBusy(label);
    try {
      const r = await api<BulkResult>(`/api/spaces/${encodeURIComponent(spaceId)}/breaks/${path}`, { method: "POST", body: JSON.stringify({ ids: [...selected], ...body }) });
      const why = [...new Set(r.skipped.map((s) => SKIP_TEXT[s.code] ?? s.code))].join("; ");
      toast(`${verb} ${r.done.length === 1 ? "1 item" : `${r.done.length} items`}.`, r.skipped.length ? { description: `${r.skipped.length} skipped: ${why}.` } : undefined);
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
      <PageHeader title="Unmatch" description="Items not matched yet. They are checked again on each run until their carry over ends." />
      <BreakSummary spaceId={spaceId} filterQuery={t.filterQuery} mine={f.assignee === "me"} onMine={() => t.set({ assignee: f.assignee === "me" ? "" : "me" })} />
      <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the unmatch items; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: f.q, recon: f.recon, assignee: f.assignee, state: f.state, reason: f.reason, age: f.age, amountMin: f.amountMin, amountMax: f.amountMax, checked: f.checked }}
        defaults={FILTER_DEFAULTS} fields={fields}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) => <>
          <FilterSearch label="Search unmatch" value={draft.q} onChange={(q) => patch({ q })} placeholder="Reference" />
          <FilterChecks label="Recon" value={draft.recon} options={withCounts(reconOptions, t.facets?.recon)} onChange={(recon) => patch({ recon })} />
          <FilterChecks label="Assignee" value={draft.assignee} options={withCounts([{ value: "me", label: "Mine" }, { value: "none", label: "Unassigned" }], t.facets?.assignee)} onChange={(assignee) => patch({ assignee })} />
          <FilterChecks label="State" value={draft.state} options={withCounts(OPEN_STATES.map((s) => ({ value: s, label: STATE_LABEL[s] })), t.facets?.state)} onChange={(state) => patch({ state })} />
          <FilterChecks label="Reason" value={draft.reason} options={withCounts(BREAK_REASONS.map((r) => ({ value: r, label: r })), t.facets?.reason)} onChange={(reason) => patch({ reason })} />
          <FilterChecks label="Age" value={draft.age} options={withCounts(AGE_BUCKETS.map((a) => ({ value: a, label: AGE_LABEL[a] })), t.facets?.age)} onChange={(age) => patch({ age })} />
          <FilterChecks label="Checked again" value={draft.checked} options={withCounts([{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], t.facets?.checked)} onChange={(checked) => patch({ checked })} />
          {/* major units of each item's currency, the absolute amount (as the Amount sort) */}
          <FilterGroup label="Amount" value={[draft.amountMin && `from ${draft.amountMin}`, draft.amountMax && `up to ${draft.amountMax}`].filter(Boolean).join(" ")}>
            <div className="grid grid-cols-2 gap-2">
              <Field id="breaks-amount-min" label="From"><Input id="breaks-amount-min" aria-label="Amount from" inputMode="decimal" autoComplete="off" value={draft.amountMin} onChange={(e) => patch({ amountMin: majorAmount(e.target.value, draft.amountMin) })} /></Field>
              <Field id="breaks-amount-max" label="Up to"><Input id="breaks-amount-max" aria-label="Amount up to" inputMode="decimal" autoComplete="off" value={draft.amountMax} onChange={(e) => patch({ amountMax: majorAmount(e.target.value, draft.amountMax) })} /></Field>
            </div>
          </FilterGroup>
        </>}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>
          <Button size="sm" variant="secondary" aria-pressed={mineOrNone} className={cn(mineOrNone && "bg-tray")}
            onClick={() => t.set({ assignee: mineOrNone ? "" : MINE_OR_NONE })}>{mineOrNone && <Icon icon={CheckIcon} />}Mine or unassigned</Button>
        </Toolbar>}
        flush icon={AlertsIcon} title="Open items" count={t.count} description={canWork ? "Select items to take, assign or mark them" : undefined}>
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
              <Button size="sm" variant="secondary" disabled={!!busy} aria-busy={busy === "take" || undefined} onClick={() => void act("take", "take", {}, "Took").catch(() => {})}><Icon icon={TakeIcon} />Take</Button>
              {canAssign && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setAssigning(true)}><Icon icon={AssignIcon} />Assign</Button>}
              <Button size="sm" variant="secondary" disabled={!!busy} aria-busy={busy === "investigating" || undefined}
                onClick={() => void act("investigating", "state", { state: "investigating" }, "Marked investigating:").catch(() => {})}><Icon icon={InvestigateIcon} />Mark investigating</Button>
              <Button size="sm" variant="secondary" disabled={!!busy} aria-busy={busy === "pending_external" || undefined}
                onClick={() => void act("pending_external", "state", { state: "pending_external" }, "Marked pending external:").catch(() => {})}><Icon icon={WaitIcon} />Mark pending external</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
            </>}
          </div>
        )}
        <DataTable label="Unmatch" rowHeight="identity" columns={columns} hidden={t.hidden} rows={rows} rowKey={(r) => r.id} loading={t.loading}
          isSelected={(r) => selected.has(r.id)} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load the unmatch items", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={filtered
            ? { icon: AlertsIcon, title: "Nothing matches these filters", description: "Change the filters, or clear them to see every item." }
            : { icon: AlertsIcon, title: "No unmatch items", description: "New ones appear after a run leaves an item without a counterpart." }} />
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
