"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CategoryChip, type Column, ColumnsMenu, CopyValue, DataTable, FilterChecks, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, RelativeTime, StatusChip, Toolbar } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Select } from "@starterkit/ui/ui/select";
import { LogIcon } from "@starterkit/ui/ui/icons";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ConnectorCallRowDto, ConnectorRowDto } from "@starterkit/shared/contracts/integrations";
import { ENVIRONMENT_LABEL, ENVIRONMENTS } from "@starterkit/shared/integrations";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { categoryChip } from "@/lib/shared/categories";
import { type CallFilters, CONNECTOR_CALLS, CONNECTOR_OPTIONS } from "@/lib/shared/queries";
import { withCounts } from "@/lib/shared/table-state";
import { CALL_LEGEND, CALL_OUTCOME_OPTIONS, callBy, callChip, callName, originKey, originLabel } from "./call-model";
import { OpenApiTabs } from "./open-api-tabs";

// the dialog loads on its first open (its copy and reveal code stay out of the first load)
const CallDialog = dynamic(() => import("./call-dialog").then((m) => m.CallDialog), { ssr: false });

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
type Filters = Pick<CallFilters, "q" | "connector" | "environment" | "outcome" | "origin">;
const FILTER_DEFAULTS: Filters = { q: "", connector: "", environment: "", outcome: "", origin: "" };
const ENVIRONMENT_OPTIONS = ENVIRONMENTS.map((value) => ({ value, label: ENVIRONMENT_LABEL[value] }));

/**
 * The call log's columns: the call (opens its dialog), outcome, the bank's answer, where it came from, who, when; the
 * environment, duration, external ID, attempt and host until chosen.
 */
export const callColumns = (open: (id: string) => void, connectorName: (id: string) => string | undefined): Column<ConnectorCallRowDto>[] => [
  { key: "call", header: "Call", mobile: "title", className: "min-w-48", cell: (r) => (
    <span className="grid min-w-0 justify-items-start">
      <button type="button" className={`text-left ${LINK}`} onClick={() => open(r.id)}>{callName(r)}</button>
      <span className="truncate text-caption text-fg-3">{connectorName(r.connector.id) ?? r.connector.name} · <span className="font-mono">{r.method} {r.path}</span></span>
    </span>
  ) },
  { key: "outcome", header: "Outcome", mobile: "meta", hideable: false, cell: (r) => { const c = callChip(r.outcome); return <StatusChip health={c.health} label={c.label} />; } },
  { key: "bank", header: "Bank answer", mobile: "meta", cell: (r) => (
    <span className="grid"><span className="font-mono text-caption">{[r.httpStatus, r.code].filter((x) => x !== null).join(" · ") || "—"}</span>{r.message && <span className="text-caption text-fg-3">{r.message}</span>}</span>
  ) },
  { key: "origin", header: "From", mobile: "meta", className: "min-w-40", cell: (r) => (
    <span className="grid min-w-0">
      {r.origin.href ? <Link href={r.origin.href} className={`truncate ${LINK}`}>{r.origin.label}</Link> : <span className="truncate">{r.origin.label}</span>}
      <span className="text-caption text-fg-3">{originLabel(originKey(r.origin))}</span>
    </span>
  ) },
  { key: "by", header: "By", mobile: "meta", className: "whitespace-nowrap", cell: (r) => { const b = callBy(r); return <span className="grid"><span>{b.name}</span>{b.note && <span className="text-caption text-fg-3">{b.note}</span>}</span>; } },
  { key: "startedAt", header: "When", sortable: true, mobile: "meta", className: "whitespace-nowrap", cell: (r) => <RelativeTime at={Date.parse(r.startedAt)} /> },
  { key: "environment", header: "Environment", mobile: "meta", defaultHidden: true, cell: (r) => <CategoryChip label={ENVIRONMENT_LABEL[r.environment]} slot={categoryChip("environment", r.environment)} /> },
  { key: "durationMs", header: "Duration", sortable: true, mobile: "meta", defaultHidden: true, align: "right", className: "whitespace-nowrap tabular", cell: (r) => `${formatNumber(r.durationMs)} ms` },
  { key: "externalId", header: "External ID", mobile: "hidden", defaultHidden: true, className: "max-w-56", cell: (r) => (r.externalId ? <CopyValue value={r.externalId} label="external ID" /> : <span className="text-fg-3">—</span>) },
  { key: "attempt", header: "Attempt", mobile: "hidden", defaultHidden: true, align: "right", className: "tabular", cell: (r) => formatNumber(r.attempt) },
  { key: "host", header: "Host", mobile: "hidden", defaultHidden: true, cell: (r) => <span className="font-mono text-caption">{r.host || "—"}</span> },
];

/**
 * The connector call log (Open API): every call this app made to a bank, or tried and couldn't send, newest first,
 * today by default (the header's date range). A call opens in a dialog; integration.debug shows it in full.
 */
export function CallsPage({ canDebug }: { canDebug: boolean }) {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const t = useTableQuery<ConnectorCallRowDto, CallFilters>(CONNECTOR_CALLS);
  const options = useQuery({ queryKey: CONNECTOR_OPTIONS.key, queryFn: () => api<Page<ConnectorRowDto>>(CONNECTOR_OPTIONS.url) });
  const connectors = options.data?.items ?? [];
  const opened = sp.get("call");
  const setOpened = (id: string | null) => {
    const next = new URLSearchParams(sp.toString());
    if (id) next.set("call", id); else next.delete("call");
    router.replace(`${path}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  const columns = callColumns(setOpened, (id) => connectors.find((c) => c.id === id)?.name);
  const origins = Object.keys(t.facets?.origin ?? {}).sort().map((value) => ({ value, label: originLabel(value) }));
  const filtered = !!(t.state.q || t.state.connector || t.state.environment || t.state.outcome || t.state.origin);
  const FIELDS = [{ key: "q", label: "Search" }, { key: "connector", label: "Connector", format: (v: string) => connectors.find((c) => c.id === v)?.name ?? "One connector" },
    { key: "environment", label: "Environment" }, { key: "outcome", label: "Outcome" }, { key: "origin", label: "From" }] as const;
  return (
    <div className="grid gap-section">
      <PageHeader title="Call log" description="Every call this app made to a bank's Open API: where it came from, who made it, and what the bank answered." />
      <OpenApiTabs current="/integrations/calls" />
      <FilterSurface>
        {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the call log; showing the calls loaded before. {errorText(t.staleError)}</Notice>}
        <FilterLayout busy={t.paging.busy} values={{ q: t.state.q, connector: t.state.connector, environment: t.state.environment, outcome: t.state.outcome, origin: t.state.origin }} defaults={FILTER_DEFAULTS} fields={FIELDS}
          onApply={(values, o) => t.set(values, o)}
          filters={(draft, patch) => <>
            <FilterSearch label="Search calls" value={draft.q} onChange={(q) => patch({ q })} placeholder="External ID, path or where it came from" />
            <span className="grid gap-1.5">
              <span className="text-label text-fg">Connector</span>
              <Select aria-label="Connector" value={draft.connector} onChange={(e) => patch({ connector: e.target.value })}>
                <option value="">Every connector</option>{connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </span>
            <FilterChecks label="Outcome" value={draft.outcome} options={withCounts(CALL_OUTCOME_OPTIONS, t.facets?.outcome)} onChange={(outcome) => patch({ outcome })} />
            <FilterChecks label="Environment" value={draft.environment} options={withCounts(ENVIRONMENT_OPTIONS, t.facets?.environment)} onChange={(environment) => patch({ environment })} />
            {origins.length > 0 && <FilterChecks label="From" value={draft.origin} options={withCounts(origins, t.facets?.origin)} onChange={(origin) => patch({ origin })} />}
          </>}>
          {({ summary }) => (
            <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
              flush icon={LogIcon} title="All calls" count={t.count} legend={CALL_LEGEND}>
              {summary}
              <DataTable label="Connector calls" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading}
                sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
                error={t.loadError ? { title: "Couldn't load the call log", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
                empty={filtered
                  ? { icon: LogIcon, title: "No calls match", description: "Change the filters or the date range, or clear them to see every call." }
                  : { icon: LogIcon, title: "No calls in this range", description: "A call appears here when Try it, Check token or an approved action calls a bank. Widen the date range to see older calls." }} />
            </Panel>
          )}
        </FilterLayout>
      </FilterSurface>
      {opened && <CallDialog id={opened} canDebug={canDebug} onClose={() => setOpened(null)} />}
    </div>
  );
}
