"use client";

import { mayDo } from "@starterkit/shared/spaces";
import type { ReportTemplateDto } from "@starterkit/shared/contracts/reports";
import Link from "next/link";
import { useMemo } from "react";
import { BlockedButton, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Panel, Toolbar } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, FileIcon } from "@starterkit/ui/ui/icons";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { REPORT_TEMPLATES, type ReportTemplateFilters } from "@/lib/shared/queries";
import { templateColumns } from "./report-columns";
import { NEW_TEMPLATE_REASON } from "./report-text";
import { ReportsTabs } from "./reports-tabs";
import { reportsHref, useSpaceRoles } from "./use-reports";

const DEFAULTS: ReportTemplateFilters = { q: "", recon: "" };
const FIELDS = [{ key: "q", label: "Search" }] as const;

/** Reports · Templates: the space's report templates, one per kind of file a recon gives. */
export function TemplatesPage({ spaceId }: { spaceId: string }) {
  const t = useTableQuery<ReportTemplateDto, ReportTemplateFilters>(useMemo(() => REPORT_TEMPLATES(spaceId), [spaceId]));
  const columns = useMemo(() => templateColumns(spaceId), [spaceId]);
  const can = mayDo(useSpaceRoles(spaceId), "editReports");
  return (
    <div className="grid gap-section">
      <PageHeader title="Reports" description="Report templates: what each file holds, its format, and when it is made."
        actions={can ? <Button variant="create-solid" asChild><Link href={reportsHref(spaceId, "/templates/new")}><Icon icon={AddIcon} />New report template</Link></Button>
          : <BlockedButton variant="create-solid" reason={NEW_TEMPLATE_REASON}><Icon icon={AddIcon} />New report template</BlockedButton>} />
      <ReportsTabs spaceId={spaceId} current="templates" />
      <FilterSurface>
        <FilterLayout busy={t.paging.busy} values={{ q: t.state.q, recon: t.state.recon }} defaults={DEFAULTS} fields={FIELDS} onApply={(values, options) => t.set(values, options)}
          filters={(draft, patch) => <FilterSearch label="Search templates" value={draft.q} onChange={(q) => patch({ q })} placeholder="Name" />}>
          {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
            flush icon={FileIcon} title="All report templates" count={t.count}>
            {summary}
            <DataTable label="Report templates" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading}
              sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
              error={t.loadError ? { title: "Couldn't load report templates", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
              empty={t.state.q ? { icon: FileIcon, title: "No templates match", description: "Change the search, or clear it to see every template." }
                : { icon: FileIcon, title: "No report templates yet", description: "Templates appear here once a config maker creates one from a recon." }} />
          </Panel>}
        </FilterLayout>
      </FilterSurface>
    </div>
  );
}
