"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CategoryChip, type Column, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, RelativeTime, StatusChip, Toolbar } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, ExternalLinkIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { ConnectorDetailDto, ConnectorRowDto } from "@starterkit/shared/contracts/integrations";
import { ENVIRONMENT_LABEL, PROFILE_LABEL } from "@starterkit/shared/integrations";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { categoryChip, statusChip, statusTone } from "@/lib/shared/categories";
import { CONNECTORS } from "@/lib/shared/queries";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const FILTER_DEFAULTS = { q: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }] as const;
const empty = { baseUrl: "", host: "", partnerId: "", channelId: "", verifyTls: false };

/** The last call's result in the live environment as a health chip; null = never called there. */
export const linkChip = (l: ConnectorRowDto["link"]) =>
  l.state === "none" ? null : l.state === "answered" ? statusChip("success", "Answering")
    : l.state === "paused" ? statusChip("error", "Calls paused") : statusChip("unanswered", l.failures > 1 ? `${l.failures} calls unanswered` : "Last call unanswered");

/** The connectors list (audit §5.8): seven columns at 1440, Changed hidden until chosen. */
export const COLUMNS: Column<ConnectorRowDto>[] = [
  { key: "name", header: "Connector", sortable: true, mobile: "title", className: "min-w-56", cell: (r) => (
    <span className="grid min-w-0">
      <Link href={`/integrations/${encodeURIComponent(r.id)}`} className={LINK}>{r.name}</Link>
      <span className="text-caption text-fg-3">{PROFILE_LABEL[r.profile]}</span>
    </span>
  ) },
  { key: "status", header: "Status", mobile: "meta", cell: (r) => (r.disabled ? <StatusChip health={statusTone("off")} label="Turned off" />
    : r.open ? <StatusChip health={statusTone(r.open.status === "draft" ? "draft" : "waiting")} label={r.open.status === "draft" ? `Draft ${r.open.version}` : `Version ${r.open.version} waits`} />
      : r.published ? <StatusChip health={statusTone("live")} label="Live" /> : <StatusChip health={statusTone("not_live")} label="Not live" />) },
  { key: "environment", header: "Environment", mobile: "meta", cell: (r) => (r.published && r.active
    ? <CategoryChip label={ENVIRONMENT_LABEL[r.active]} slot={categoryChip("environment", r.active)} /> : <span className="text-fg-3">—</span>) },
  { key: "live", header: "Version", mobile: "meta", className: "whitespace-nowrap", cell: (r) => (r.published ? `Version ${r.published.version}` : <span className="text-fg-3">Not live</span>) },
  { key: "link", header: "Bank link", mobile: "meta", className: "whitespace-nowrap", cell: (r) => { const l = linkChip(r.link); return l ? <StatusChip health={l.health} label={l.label} /> : <span className="text-fg-3">No calls yet</span>; } },
  { key: "operations", header: "Operations", mobile: "meta", align: "right", className: "tabular", cell: (r) => r.operations },
  { key: "usedBy", header: "Used by", mobile: "meta", className: "whitespace-nowrap", cell: (r) => (r.usedBy ? `${r.usedBy} ${r.usedBy === 1 ? "recon" : "recons"}` : <span className="text-fg-3">Not used</span>) },
  { key: "updatedAt", header: "Changed", mobile: "meta", defaultHidden: true, className: "whitespace-nowrap", cell: (r) => <RelativeTime at={Date.parse(r.updatedAt)} /> },
];

/**
 * Open API connectors (DEC-053): the bank APIs recons call, each with its environments, credentials and operations.
 * New connector saves a draft at once and opens it, so nothing typed is lost.
 */
export function ConnectorsPage({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const t = useTableQuery<ConnectorRowDto, { q: string }>(CONNECTORS);
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      for (let n = 1; ; n++) {
        const name = n === 1 ? "New connector" : `New connector ${n}`;
        const c = await api<ConnectorDetailDto>("/api/integrations/connectors", {
          method: "POST", body: JSON.stringify({ spec: { name, profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: empty, prod: empty }, operations: [] } }),
        }).catch((e: unknown) => { if (n < 20 && (e as { code?: string }).code === "duplicate") return null; throw e; });
        if (c) { router.push(`/integrations/${encodeURIComponent(c.id)}`); return; }
      }
    } catch (e) { toast.error(errorText(e)); setBusy(false); }
  }
  return (
    <div className="grid gap-section">
      <PageHeader title="Open API" description="The bank APIs that recons call when a change is approved: their environments, credentials and operations."
        actions={canManage ? <Button type="button" variant="create-solid" onClick={() => void create()} disabled={busy} aria-busy={busy || undefined}><Icon icon={busy ? SpinnerIcon : AddIcon} className={busy ? "motion-safe:animate-spin" : undefined} />New connector</Button> : undefined} />
      <FilterSurface>
        {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the connectors; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
        <FilterLayout busy={t.paging.busy} values={{ q: t.state.q }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS} onApply={(values, options) => t.set(values, options)}
          filters={(draft, patch) => <FilterSearch label="Search connectors" value={draft.q} onChange={(q) => patch({ q })} placeholder="Name" />}>
          {({ summary }) => (
            <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={COLUMNS} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
              flush icon={ExternalLinkIcon} title="All connectors" count={t.count}>
              {summary}
              <DataTable label="Connectors" columns={COLUMNS} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading}
                sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
                error={t.loadError ? { title: "Couldn't load connectors", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
                empty={t.state.q
                  ? { icon: ExternalLinkIcon, title: "No connectors match", description: "Change the search, or clear it to see every connector." }
                  : { icon: ExternalLinkIcon, title: "No connectors yet", description: "A connector appears here once an Open API manager adds one." }} />
            </Panel>
          )}
        </FilterLayout>
      </FilterSurface>
    </div>
  );
}
