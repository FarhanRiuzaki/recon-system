"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ColumnsMenu, DataTable, EmptyState, ErrorState, Field, FilterChecks, FilterGroup, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { appDayStart, formatDate, formatNumber } from "@starterkit/ui/lib/format";
import { Button, buttonVariants } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { EditIcon, ReportsIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import type { ReconDto, ReconRowDto } from "@starterkit/shared/contracts/recon";
import type { ResultColumnsDto, ResultCountsDto, ResultRowDto } from "@starterkit/shared/contracts/results";
import { selectionState, selectionValues } from "@starterkit/shared/filter-selection";
import { RESULT_STATUS_LABEL, RESULT_STATUSES, type ResultStatus, SIDE_STATES, type SideState } from "@starterkit/shared/results";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { ENGINE_KEY, spaceDetail } from "@/lib/shared/queries";
import { reconDetail, reconOptions, RESULTS, resultColumns as columnsQuery, resultCountsUrl, type ResultFilters } from "@/lib/shared/queries-recon";
import { withCounts } from "@/lib/shared/table-state";
import { resultColumns } from "./result-columns";
import { pageState, pickRecon, RESULT_LEGEND, resultIcon, SIDE_HEADER, SIDE_LABEL } from "./result-model";

const ExplainDialog = dynamic(() => import("./explain-dialog"), { ssr: false });

type Filters = Omit<ResultFilters, "recon">;
const FILTER_DEFAULTS: Filters = { q: "", dateFrom: "", dateTo: "", result: "", sideA: "", sideB: "" };
const day = (d: string) => formatDate(appDayStart(d));
const STATUS_OPTIONS = RESULT_STATUSES.map((s) => ({ value: s, label: RESULT_STATUS_LABEL[s] }));
const SIDE_OPTIONS = SIDE_STATES.map((s) => ({ value: s, label: SIDE_LABEL[s] }));

const FIELDS = [
  { key: "q", label: "Reference" },
  { key: "dateFrom", label: "Business date from", format: day },
  { key: "dateTo", label: "Business date to", format: day },
  { key: "result", label: "Status", multiple: true, format: (v: string) => RESULT_STATUS_LABEL[v as ResultStatus] ?? v },
  { key: "sideA", label: SIDE_HEADER[0], multiple: true, format: (v: string) => SIDE_LABEL[v as SideState] ?? v },
  { key: "sideB", label: SIDE_HEADER[1], multiple: true, format: (v: string) => SIDE_LABEL[v as SideState] ?? v },
] as const;

/**
 * Operation result (spec docs/superpowers/specs/2026-11-24-operation-result-design.md): one recon's results for a
 * business-date range (today by default), one row per match group or lone item, its overall status and each side's,
 * the columns its recon chose. A preview: work on a row happens on its Unmatch page (Open).
 */
export function ResultsPage({ spaceId }: { spaceId: string }) {
  const ro = reconOptions(spaceId);
  const recons = useQuery({ queryKey: ro.key, queryFn: () => api<Page<ReconRowDto>>(ro.url) });
  const published = useMemo(() => (recons.data?.items ?? []).filter((r) => r.publishedVersion !== null), [recons.data]);
  const [explaining, setExplaining] = useState<ResultRowDto | null>(null);
  // the URL names the recon (page.tsx sends a link without one to the first that has results); until the list loads, trust it
  const wanted = useSearchParams().get("recon");
  const configId = recons.data ? pickRecon(recons.data.items, wanted) : wanted;
  const def = useMemo(() => RESULTS(spaceId, configId ?? ""), [spaceId, configId]);
  const t = useTableQuery<ResultRowDto, ResultFilters>(def, !!configId);
  const f = t.state;

  const rq = reconDetail(spaceId, configId ?? "");
  const recon = useQuery({ queryKey: rq.key, queryFn: () => api<ReconDto>(rq.url), enabled: !!configId }).data;
  const sideLabels = recon?.published?.spec.sides;
  // config makers and space admins set the columns on the recon page (Configuration, Operation result columns)
  const roles = useQuery({ queryKey: spaceDetail(spaceId).key, queryFn: () => api<SpaceRowDto>(spaceDetail(spaceId).url) }).data?.roles ?? [];
  const setupHref = configId && (roles.includes("config_maker") || roles.includes("space_admin"))
    ? `/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(configId)}?tab=configuration#result-columns` : null;
  const sides = useMemo<[string, string]>(() => [sideLabels?.[0].label ?? "Side A", sideLabels?.[1].label ?? "Side B"], [sideLabels]);
  const cq = columnsQuery(spaceId, configId ?? "");
  const cols = useQuery({ queryKey: cq.key, queryFn: () => api<ResultColumnsDto>(cq.url), enabled: !!configId });
  const countsUrl = resultCountsUrl(spaceId, configId ?? "", t.filterQuery);
  const counts = useQuery({ queryKey: [ENGINE_KEY[0], countsUrl], queryFn: () => api<ResultCountsDto>(countsUrl), enabled: !!configId, placeholderData: keepPreviousData }).data;

  const columns = useMemo(() => resultColumns(spaceId, cols.data?.columns ?? [], sides, setExplaining), [spaceId, cols.data, sides]);
  const picked = selectionValues(f.result);
  const only = (s: ResultStatus) => picked.length === 1 && picked[0] === s;
  const shownCounts = RESULT_STATUSES.filter((s) => (counts?.counts[s] ?? 0) > 0);
  const filtered = Object.entries(FILTER_DEFAULTS).some(([k]) => f[k as keyof Filters] !== "");
  const loadError = t.loadError ?? cols.error;
  const state = pageState({ loaded: !!recons.data, failed: !!recons.error, published: published.length }, configId);

  return (
    <div className="grid gap-section">
      <PageHeader title="Operation result" description="Every result of one recon for the business dates you pick: matched, unmatch, posted, written off or closed. Work on an item from its Unmatch page."
        actions={setupHref ? <Link href={setupHref} className={buttonVariants({ variant: "edit", size: "sm" })}><Icon icon={EditIcon} />Set up columns</Link> : undefined} />
      {state === "none" ? (
        <Panel><EmptyState icon={ReportsIcon} title="No recon has results yet" description="Results show here once a recon's first version is approved and runs." /></Panel>
      ) : state === "error" ? (
        <Panel><div className="p-4"><ErrorState title="Couldn't load the recons" cause={errorText(recons.error)} onRetry={() => void recons.refetch()} /></div></Panel>
      ) : (
      <FilterSurface>
        {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the results; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
        {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
        <FilterLayout busy={t.paging.busy} values={{ q: f.q, dateFrom: f.dateFrom, dateTo: f.dateTo, result: f.result, sideA: f.sideA, sideB: f.sideB }}
          defaults={FILTER_DEFAULTS} fields={FIELDS} onApply={(values, options) => t.set(values, options)} filters={(draft, patch) => <>
            <FilterSearch label="Search results" value={draft.q} onChange={(q) => patch({ q })} placeholder="Reference" />
            {/* business dates, Asia/Jakarta days; none = today */}
            <FilterGroup label="Business date" value={draft.dateFrom || draft.dateTo ? [draft.dateFrom && day(draft.dateFrom), draft.dateTo && day(draft.dateTo)].filter(Boolean).join(" – ") : "Today"}>
              <div className="grid grid-cols-2 gap-2">
                <Field id="results-date-from" label="From"><Input id="results-date-from" type="date" value={draft.dateFrom} max={draft.dateTo || undefined} onChange={(e) => patch({ dateFrom: e.target.value })} /></Field>
                <Field id="results-date-to" label="To"><Input id="results-date-to" type="date" value={draft.dateTo} min={draft.dateFrom || undefined} onChange={(e) => patch({ dateTo: e.target.value })} /></Field>
              </div>
            </FilterGroup>
            <FilterChecks label="Status" value={draft.result} options={withCounts(STATUS_OPTIONS, counts?.counts)} onChange={(result) => patch({ result })} />
            <FilterChecks label={SIDE_HEADER[0]} value={draft.sideA} options={withCounts(SIDE_OPTIONS, counts?.sideA)} onChange={(sideA) => patch({ sideA })} />
            <FilterChecks label={SIDE_HEADER[1]} value={draft.sideB} options={withCounts(SIDE_OPTIONS, counts?.sideB)} onChange={(sideB) => patch({ sideB })} />
          </>}>
          {({ summary }) => (
            <Panel flush icon={ReportsIcon} title="Results" count={t.count} legend={RESULT_LEGEND}
              description={f.dateFrom || f.dateTo ? `Business date ${[f.dateFrom || f.dateTo, f.dateTo || f.dateFrom].map(day).filter((x, i, a) => a.indexOf(x) === i).join(" – ")}` : "Business date today"}
              toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>
                <Select aria-label="Recon" className="w-full md:w-64" value={configId ?? ""} onChange={(e) => t.set({ recon: e.target.value })} disabled={!recons.data}>
                  {!recons.data && configId && <option value={configId}>Loading recons…</option>}
                  {published.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
              </Toolbar>}>
              {summary}
              {shownCounts.length > 0 && (
                <div role="group" aria-label="Results per status" className="flex flex-wrap gap-2 border-b border-line px-3 py-2">
                  {shownCounts.map((s) => (
                    <Button key={s} size="sm" variant="secondary" aria-pressed={only(s)} className={cn(only(s) && "bg-tray")}
                      onClick={() => t.set({ result: only(s) ? "" : selectionState([s]) })}>
                      <Icon icon={resultIcon(s).icon} />{RESULT_STATUS_LABEL[s]}
                      <span className="tabular text-fg-2">{formatNumber(counts!.counts[s]!)}{counts!.capped && counts!.counts[s]! >= 100_000 ? "+" : ""}</span>
                    </Button>
                  ))}
                </div>
              )}
              <DataTable label="Operation result" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading || (!!configId && cols.isPending)}
                sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
                error={loadError ? { title: "Couldn't load the results", cause: errorText(loadError), onRetry: () => { void t.query.refetch(); void cols.refetch(); } } : null}
                empty={filtered
                  ? { icon: ReportsIcon, title: "Nothing matches these filters", description: "Change the filters or the business dates, or clear them to see every result." }
                  : { icon: ReportsIcon, title: "No results on these dates", description: "Results appear after a run of this recon reads records of these business dates." }} />
            </Panel>
          )}
        </FilterLayout>
      </FilterSurface>
      )}
      {explaining && configId && <ExplainDialog spaceId={spaceId} configId={configId} reconName={published.find((r) => r.id === configId)?.name ?? null} row={explaining} sides={sides} onClose={() => setExplaining(null)} />}
    </div>
  );
}
