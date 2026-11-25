"use client";

import { mayDo } from "@starterkit/shared/spaces";
import type { ReportFileDto } from "@starterkit/shared/contracts/reports";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { BlockedButton, ColumnsMenu, DataTable, FilterChecks, FilterLayout, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, FileIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { REPORT_FILES, type ReportFileFilters } from "@/lib/shared/queries";
import { withCounts } from "@/lib/shared/table-state";
import { FILE_LEGEND, fileColumns } from "./report-columns";
import { STATUS_LABEL } from "./report-text";
import { ReportsTabs } from "./reports-tabs";
import { useReportActions, useSpaceRoles } from "./use-reports";

const GenerateDialog = dynamic(() => import("./generate-dialog").then((m) => m.GenerateDialog), { ssr: false });
const FILTER_DEFAULTS: ReportFileFilters = { final: "", status: "", madeBy: "", recon: "", template: "", run: "" };
const FIELDS = [{ key: "final", label: "Final" }, { key: "status", label: "Status" }, { key: "madeBy", label: "Made by" }] as const;
/** While a file is queued or being made, the list asks again every 3 s. */
const pollWhileMaking = (rows: readonly ReportFileDto[]) => (rows.some((f) => f.status === "queued" || f.status === "making") ? 3000 : false);
export const GENERATE_REASON = "Only a space admin, config maker, operator or reviewer makes a report.";

/** Reports · Files: every file made in the space (after runs and on request), newest first, each download logged. */
export function ReportsPage({ spaceId }: { spaceId: string }) {
  const t = useTableQuery<ReportFileDto, ReportFileFilters>(useMemo(() => REPORT_FILES(spaceId), [spaceId]), true, pollWhileMaking);
  const { retry } = useReportActions(spaceId);
  const columns = useMemo(() => fileColumns(spaceId, (id) => void retry(id).then(() => toast("Making the report again.")).catch((e) => toast.error(errorText(e)))), [spaceId, retry]);
  const can = mayDo(useSpaceRoles(spaceId), "generateReports");
  const [open, setOpen] = useState(false);
  const filtered = !!(t.state.final || t.state.status || t.state.madeBy || t.state.recon || t.state.template || t.state.run);
  return (
    <div className="grid gap-section">
      <PageHeader title="Reports" description="Report files of this space's recons, made after runs or on request. Every download is logged."
        actions={can ? <Button variant="create-solid" onClick={() => setOpen(true)}><Icon icon={AddIcon} />Generate report</Button>
          : <BlockedButton variant="create-solid" reason={GENERATE_REASON}><Icon icon={AddIcon} />Generate report</BlockedButton>} />
      <ReportsTabs spaceId={spaceId} current="files" />
      <FilterSurface>
        {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the report files; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
        <FilterLayout busy={t.paging.busy} values={{ final: t.state.final, status: t.state.status, madeBy: t.state.madeBy, recon: t.state.recon, template: t.state.template, run: t.state.run }} defaults={FILTER_DEFAULTS} fields={FIELDS}
          onApply={(values, options) => t.set(values, options)} filters={(draft, patch) => <>
            <FilterChecks label="Final" value={draft.final} options={withCounts([{ value: "final", label: "Final" }, { value: "not_final", label: "Not final" }], t.facets?.final)} onChange={(final) => patch({ final })} />
            <FilterChecks label="Status" value={draft.status} options={withCounts((Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })), t.facets?.status)} onChange={(status) => patch({ status })} />
            <FilterChecks label="Made by" value={draft.madeBy} options={withCounts([{ value: "run", label: "After a run" }, { value: "user", label: "On request" }], t.facets?.madeBy)} onChange={(madeBy) => patch({ madeBy })} />
          </>}>
          {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
            flush icon={FileIcon} title="All report files" count={t.count} legend={FILE_LEGEND}>
            {summary}
            <DataTable label="Report files" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(f) => f.id} loading={t.loading}
              sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
              error={t.loadError ? { title: "Couldn't load report files", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
              empty={filtered ? { icon: FileIcon, title: "No report files match", description: "Change the filters, or clear them to see every file." }
                : { icon: FileIcon, title: "No report files yet", description: "Files appear here after a run of a recon with an active report template, or when someone generates one." }} />
          </Panel>}
        </FilterLayout>
      </FilterSurface>
      {open && <GenerateDialog spaceId={spaceId} onClose={() => setOpen(false)} />}
    </div>
  );
}
