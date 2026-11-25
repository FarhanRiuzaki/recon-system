import Link from "next/link";
import { BlockedButton, type Column, RelativeTime, StatusChip } from "@starterkit/ui/ds";
import { formatBytes, formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ExportIcon } from "@starterkit/ui/ui/icons";
import type { ReportFileDto, ReportTemplateDto } from "@starterkit/shared/contracts/reports";
import type { ReportFileStatus } from "@starterkit/shared/reports";
import { statusTone } from "@/lib/shared/categories";
import { FORMAT_LABEL, finalText, KIND_LABEL, STATUS_LABEL, statusText, TEMPLATE_STATUS_LABEL } from "./report-text";
import { downloadHref, reportsHref } from "./use-reports";

const TONE: Record<ReportFileStatus, Parameters<typeof statusTone>[0]> = { queued: "queued", making: "in_progress", ready: "ready", failed: "failed", removed: "retired" };
/** The Files card's legend: each state's words (never colour alone). */
export const FILE_LEGEND = (Object.keys(STATUS_LABEL) as ReportFileStatus[]).map((s) => ({
  health: statusTone(TONE[s]), label: STATUS_LABEL[s],
  description: { queued: "Waiting for the worker.", making: "Being made; the share read so far.", ready: "Ready to download. Every download is logged.", failed: "The report stopped; its row says why. Make it again.", removed: "Removed after its retention; its record stays." }[s],
}));
const dates = (f: { from: string; to: string }) => (f.from === f.to ? f.from : `${f.from} – ${f.to}`);

/** A space's report files: report (template, version, format), recon, dates, status, Final, made by, size, download. */
export const FULL_REASON = "Only a space admin, a reviewer or a config checker downloads full customer data.";
export const MAKE_REASON = "Only a space admin, config maker, operator or reviewer makes a report.";
/** `can`: whether the viewer may download full customer data and make a report again (SPACE_ACTION, through mayDo). */
export const fileColumns = (spaceId: string, retry: (id: string) => void, can: { full: boolean; generate: boolean }): Column<ReportFileDto>[] => [
  { key: "report", header: "Report", mobile: "title", className: "min-w-56", cell: (f) => (
    <span className="grid">
      <Link href={reportsHref(spaceId, `/templates/${encodeURIComponent(f.templateId)}`)} className="font-medium text-fg hover:underline">{f.template}</Link>
      <span className="text-caption text-fg-3">v{f.version} · {FORMAT_LABEL[f.format]}{f.fileVersion > 1 ? ` · file ${f.fileVersion}` : ""}</span>
    </span>) },
  { key: "recon", header: "Recon", mobile: "meta", cell: (f) => f.recon },
  { key: "from", header: "Dates", sortable: true, mobile: "meta", cell: (f) => <span className="tabular-nums">{dates(f)}</span> },
  { key: "status", header: "Status", mobile: "meta", cell: (f) => <StatusChip health={statusTone(TONE[f.status])} label={statusText(f)} /> },
  { key: "final", header: "Final", mobile: "hidden", cell: (f) => <span className={f.final ? "text-fg" : "text-degraded-ink"}>{finalText(f.final)}</span> },
  { key: "madeAt", header: "Made", sortable: true, mobile: "hidden", className: "md:max-xl:hidden", cell: (f) => (
    <span className="grid"><RelativeTime at={Date.parse(f.madeAt)} /><span className="text-caption text-fg-3">{f.madeBy.kind === "run" ? "After a run" : f.madeBy.name}</span></span>) },
  { key: "size", header: "Size", align: "right", mobile: "hidden", className: "md:max-xl:hidden", cell: (f) => (f.size === null ? <span className="text-fg-3">—</span> : <span className="tabular-nums">{formatBytes(f.size)}{f.rows !== null ? ` · ${formatNumber(f.rows)} rows` : ""}</span>) },
  { key: "get", header: "", hideable: false, mobile: "lead", cell: (f) => (f.status === "ready"
    ? (f.masking === "full" && !can.full
      ? <BlockedButton variant="secondary" size="sm" reason={FULL_REASON}><Icon icon={ExportIcon} />Download</BlockedButton>
      : <Button variant="secondary" size="sm" asChild><a href={downloadHref(spaceId, f)} download><Icon icon={ExportIcon} />Download</a></Button>)
    : f.status === "failed" ? <span className="grid justify-items-start">
      {can.generate ? <Button variant="secondary" size="sm" onClick={() => retry(f.id)}>Make again</Button> : <BlockedButton variant="secondary" size="sm" reason={MAKE_REASON}>Make again</BlockedButton>}
      <span className="text-caption text-down-ink">{f.error}</span></span> : null) },
];

/** A space's report templates: name (opens it), recon, holds, format, official, status, last file. */
export const templateColumns = (spaceId: string): Column<ReportTemplateDto>[] => [
  { key: "name", header: "Name", sortable: true, mobile: "title", className: "min-w-48", cell: (t) => <Link href={reportsHref(spaceId, `/templates/${encodeURIComponent(t.id)}`)} className="font-medium text-fg hover:underline">{t.name}</Link> },
  { key: "recon", header: "Recon", mobile: "meta", cell: (t) => t.recon.name },
  { key: "kind", header: "Holds", mobile: "meta", cell: (t) => `${KIND_LABEL[t.kind]} · ${FORMAT_LABEL[t.format]}` },
  { key: "official", header: "Official", mobile: "hidden", cell: (t) => (t.official ? "Official report" : <span className="text-fg-3">Internal</span>) },
  { key: "status", header: "Status", mobile: "meta", cell: (t) => <StatusChip health={statusTone(t.status === "active" ? "active" : t.status === "retired" ? "retired" : t.status === "waiting" ? "waiting" : "draft")} label={`${TEMPLATE_STATUS_LABEL[t.status]}${t.activeVersion ? ` · v${t.activeVersion}` : ""}`} /> },
  { key: "updatedAt", header: "Last file", mobile: "hidden", className: "md:max-xl:hidden", cell: (t) => (t.lastFileAt ? <RelativeTime at={Date.parse(t.lastFileAt)} /> : <span className="text-fg-3">None yet</span>) },
];
