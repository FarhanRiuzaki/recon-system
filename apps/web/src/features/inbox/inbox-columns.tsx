import Link from "next/link";
import { type Column, RelativeTime, StatusChip, Truncate } from "@starterkit/ui/ds";
import type { StatusTone } from "@starterkit/ui/lib/status";
import { formatBytes } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { FileIcon, FolderIcon } from "@starterkit/ui/ui/icons";
import type { InboxFileDto, InboxFolderDto, InboxState } from "@starterkit/shared/contracts/inbox";
import { statusTone } from "@/lib/shared/categories";
import { folderHref, stateSummary } from "./upload";

/** A file's state for a source: its tone by meaning (lib/shared/categories) and the card legend's words. */
export const STATE: Record<InboxState, { health: StatusTone; label: string; description: string }> = {
  waiting: { health: statusTone("waiting"), label: "Waiting", description: "No source has read the file yet. A source picks it up once it is complete." },
  ingested: { health: statusTone("done"), label: "Ingested", description: "The source took the file's rows in." },
  duplicate: { health: statusTone("check"), label: "Duplicate", description: "The source refused it: a file with the same content was ingested before." },
  failed: { health: statusTone("failed"), label: "Failed", description: "The source couldn't read the file. Its page says why." },
};
export const STATE_LEGEND = (Object.keys(STATE) as InboxState[]).map((k) => STATE[k]);

/** The folders of a space's inbox (the space root, S3-style): name (opens the folder), files, newest, status summary. */
export const folderColumns = (spaceId: string): Column<InboxFolderDto>[] => [
  { key: "name", header: "Name", mobile: "title", className: "min-w-48", cell: (f) => (
    <Link href={folderHref(spaceId, f.name)} className="inline-flex items-center gap-2 font-medium text-fg hover:underline">
      <Icon icon={FolderIcon} className="text-fg-3" /><span className="font-mono">{f.name}/</span>
    </Link>) },
  { key: "files", header: "Files", align: "right", mobile: "meta", cell: (f) => <span className="tabular-nums">{f.files === 1 ? "1 file" : `${f.files} files`}</span> },
  { key: "newest", header: "Last file", mobile: "hidden", className: "md:max-xl:hidden", cell: (f) => (f.newestAt ? <RelativeTime at={Date.parse(f.newestAt)} /> : <span className="text-fg-3">None yet</span>) },
  { key: "status", header: "Status", mobile: "meta", cell: (f) => {
    const parts = stateSummary(f.summary);
    return parts.length
      ? <span className="flex flex-wrap gap-1.5">{parts.map(([s, n]) => <StatusChip key={s} health={STATE[s].health} label={`${n} ${STATE[s].label.toLowerCase()}`} />)}</span>
      : <span className="text-fg-3">No source reads it</span>;
  } },
];

/** The files of one folder: name, size, modified, uploaded by, the state per reading source. */
export const FILE_COLUMNS: Column<InboxFileDto>[] = [
  { key: "name", header: "Name", sortable: true, mobile: "title", className: "min-w-56", cell: (f) => (
    <span className="inline-flex min-w-0 items-center gap-2"><Icon icon={FileIcon} className="shrink-0 text-fg-3" /><Truncate title={f.name}><span className="font-medium text-fg">{f.name}</span></Truncate></span>) },
  { key: "size", header: "Size", sortable: true, align: "right", mobile: "meta", cell: (f) => <span className="tabular-nums">{formatBytes(f.size)}</span> },
  { key: "modifiedAt", header: "Modified", sortable: true, mobile: "meta", cell: (f) => <RelativeTime at={Date.parse(f.modifiedAt)} /> },
  { key: "uploadedBy", header: "Uploaded by", mobile: "hidden", className: "md:max-xl:hidden", cell: (f) => (f.uploadedBy ? f.uploadedBy.name : <span className="text-fg-3">Not uploaded here</span>) },
  { key: "sources", header: "Status", mobile: "meta", cell: (f) => (f.sources.length
    ? <span className="flex flex-wrap gap-1.5">{f.sources.map((s) => <StatusChip key={s.sourceId} health={STATE[s.state].health} label={`${STATE[s.state].label} · ${s.sourceName}`} />)}</span>
    : <span className="text-fg-3">No source reads it</span>) },
];
