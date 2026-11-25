"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ActionMenu, BlockedButton, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, FolderIcon, UploadIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { BulkResult } from "@starterkit/shared/contracts/common";
import type { InboxFileDto } from "@starterkit/shared/contracts/inbox";
import { cn } from "@starterkit/ui/lib/cn";
import { mayDo } from "@starterkit/shared/spaces";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { PageHeader } from "@/components/shell/page-header";
import { api, ApiError, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { INBOX_FILES } from "@/lib/shared/queries";
import { deletable, FILE_COLUMNS, fileColumns, folderColumns, STATE_LEGEND } from "./inbox-columns";
import { folderHref, inboxFilesPath } from "./upload";
import { INBOX_KEY, useInboxFolders, useInboxSpace } from "./use-inbox";

const loadDialogs = () => import("./inbox-dialogs");
const CreateFolderDialog = dynamic(() => loadDialogs().then((m) => m.CreateFolderDialog), { ssr: false });
const UploadDialog = dynamic(() => loadDialogs().then((m) => m.UploadDialog), { ssr: false });
const FileDetailsDialog = dynamic(() => loadDialogs().then((m) => m.FileDetailsDialog), { ssr: false });
const preload = () => void loadDialogs();

const UPLOAD_REASON = "Only operators and source admins of this space upload files.";
const NOT_SET_UP = "File inbox isn't set up on this server. Ask IT to set INBOX_ROOTS.";

/**
 * Inbox files (S3-console style): the space root lists its folders; `?folder=` opens one and lists its files. Operators
 * and source admins upload; source admins create and delete folders and delete a file no source has read yet.
 */
export function InboxPage({ spaceId }: { spaceId: string }) {
  const folder = useSearchParams().get("folder");
  const space = useInboxSpace(spaceId);
  const roles = space?.roles ?? [];
  const [dialog, setDialog] = useState<"folder" | "upload" | null>(null);
  const [dropped, setDropped] = useState<readonly File[] | undefined>(undefined);
  const upload = mayDo(roles, "uploadInbox"), manage = mayDo(roles, "manageInbox");
  const name = space?.name ?? "";
  const trail = folder ? [{ label: "Inbox files", href: folderHref(spaceId, null) }] : [];
  return (
    <div className="grid gap-section" onPointerDown={preload} onFocus={preload}>
      <PageHeader title={folder ? `${folder}/` : "Inbox files"} trail={trail}
        description={folder ? `Files in ${name} / ${folder}/. A file source pointed at this folder reads them.` : `Folders of the ${name} space. Upload a file into a folder; a file source pointed at the folder reads it.`}
        actions={folder
          ? <BlockedButton reason={upload ? null : UPLOAD_REASON} onClick={() => { setDropped(undefined); setDialog("upload"); }}><Icon icon={UploadIcon} />Upload files</BlockedButton>
          : (manage ? <Button variant="create" onClick={() => setDialog("folder")}><Icon icon={AddIcon} />Create folder</Button> : undefined)} />
      {folder
        ? <FilesView spaceId={spaceId} folder={folder} name={name} manage={manage} onDropFiles={upload ? (files) => { setDropped(files); setDialog("upload"); } : undefined} />
        : <FoldersView spaceId={spaceId} name={name} manage={manage} />}
      {dialog === "folder" && <CreateFolderDialog spaceId={spaceId} onClose={() => setDialog(null)} />}
      {dialog === "upload" && folder && <UploadDialog spaceId={spaceId} folder={folder} initial={dropped} onClose={() => { setDialog(null); setDropped(undefined); }} />}
    </div>
  );
}

function Crumbs({ spaceId, name, folder }: { spaceId: string; name: string; folder: string | null }) {
  return (
    <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 font-mono text-body-sm text-fg-2">
      {folder ? <Link href={folderHref(spaceId, null)} className="hover:underline">{name || "Space"}</Link> : <span className="text-fg">{name || "Space"}</span>}
      <span aria-hidden="true">/</span>
      {folder && <><span className="text-fg">{folder}</span><span aria-hidden="true">/</span></>}
    </nav>
  );
}

function FoldersView({ spaceId, name, manage }: { spaceId: string; name: string; manage: boolean }) {
  const q = useInboxFolders(spaceId);
  const qc = useQueryClient();
  const [del, setDel] = useState<string | null>(null);
  const notSetUp = q.error instanceof ApiError && q.error.code === "invalid_state";
  const rows = q.data?.folders ?? [];
  return (
    <>
      <Panel flush icon={FolderIcon} title={<Crumbs spaceId={spaceId} name={name} folder={null} />} count={q.data ? rows.length : undefined} legend={STATE_LEGEND}>
        <DataTable label="Folders" rowHeight="identity" columns={folderColumns(spaceId)} rows={rows} rowKey={(f) => f.name} loading={q.isPending}
          error={q.error && !notSetUp ? { title: "Couldn't load the folders", cause: errorText(q.error), onRetry: () => void q.refetch() } : null}
          empty={notSetUp
            ? { icon: FolderIcon, title: "File inbox isn't set up", description: NOT_SET_UP }
            : { icon: FolderIcon, title: "No folders yet", description: manage ? "Create a folder to upload files into." : "A source admin of this space creates the folders." }}
          rowActions={manage ? (f) => (
            <ActionMenu label={`Actions for ${f.name}`} actions={[
              { id: "delete", label: "Delete folder", destructive: true, disabled: f.files > 0, hint: f.files > 0 ? "Delete the files in this folder first." : undefined, onSelect: () => setDel(f.name) },
            ]} />
          ) : undefined} />
      </Panel>
      {del && <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setDel(null); }} destructive auditFields={false} reasons={[]}
        title={`Delete folder ${del}/`} description="The folder is empty. A source that reads it must be changed first."
        impact={[`${del}/ is removed from this space's inbox.`]} actionLabel="Delete folder"
        onConfirm={async () => {
          await api(`/api/spaces/${encodeURIComponent(spaceId)}/inbox/folders/${encodeURIComponent(del)}`, { method: "DELETE" });
          toast(`Deleted folder ${del}.`);
          await qc.invalidateQueries({ queryKey: INBOX_KEY });
          setDel(null);
        }} />}
    </>
  );
}

function FilesView({ spaceId, folder, name, manage, onDropFiles }: { spaceId: string; folder: string; name: string; manage: boolean; onDropFiles?: (files: File[]) => void }) {
  const t = useTableQuery<InboxFileDto, { q: string }>(INBOX_FILES(spaceId, folder));
  const qc = useQueryClient();
  const [open, setOpen] = useState<InboxFileDto | null>(null);
  const [del, setDel] = useState<InboxFileDto | null>(null);
  const [bulk, setBulk] = useState(false);
  const [over, setOver] = useState(false);
  const read = (f: InboxFileDto) => !deletable(f);
  // the ticked files of this page (a source admin): cleared when the page shows other rows
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const shown = t.rows.map((f) => f.name).join("\n");
  const [selectedOn, setSelectedOn] = useState(shown);
  if (selectedOn !== shown) { setSelectedOn(shown); setSelected(new Set()); }
  const pickable = t.rows.filter(deletable);
  const allOn = pickable.length > 0 && pickable.every((f) => selected.has(f.name));
  const toggle = (n: string) => setSelected((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(pickable.map((f) => f.name)));
  const columns = manage ? fileColumns({ has: (n) => selected.has(n), toggle, all: { checked: allOn, count: pickable.length, toggle: toggleAll } }) : FILE_COLUMNS;
  const dropProps = onDropFiles ? {
    onDragOver: (e: React.DragEvent) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setOver(true); } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); const files = [...e.dataTransfer.files]; if (files.length) onDropFiles(files); },
  } : {};
  // a file download (Content-Disposition: attachment), not a page: a link clicked, so the browser saves it and stays here
  const download = (f: InboxFileDto) => {
    const a = document.createElement("a");
    a.href = `${inboxFilesPath(spaceId, folder)}/download?name=${encodeURIComponent(f.name)}`;
    a.download = f.name;
    a.click();
  };
  return (
    <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the files; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: t.state.q }} defaults={{ q: "" }} fields={[{ key: "q", label: "Search" }]}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) =>
          <FilterSearch label="Search files" value={draft.q} onChange={(q) => patch({ q })} placeholder="File name" />}>
        {({ summary }) => <div {...dropProps} className={cn("rounded-xl", over && "outline-2 outline-dashed outline-offset-2 outline-primary")}>
          <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
          flush icon={FolderIcon} title={<Crumbs spaceId={spaceId} name={name} folder={folder} />} count={t.count} legend={STATE_LEGEND}
          description={onDropFiles ? "Drop files on the table to upload them." : undefined}>
          {summary}
          {manage && pickable.length > 0 && (
            <div role="region" aria-label="Bulk actions" className={cn("flex min-h-12 flex-wrap items-center gap-2 border-b border-line bg-card px-3 py-2", selected.size > 0 ? "max-md:sticky max-md:top-(--topbar-h) max-md:z-20" : "md:hidden")}>
              <label className="flex items-center gap-2 text-body-sm text-fg-2">
                <input type="checkbox" className="size-4 cursor-pointer accent-primary" checked={allOn} onChange={toggleAll} />
                {selected.size > 0 ? `${selected.size} selected` : `Select all ${pickable.length} deletable on this page`}
              </label>
              {selected.size > 0 && <>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
                <Button size="sm" variant="destructive" onClick={() => setBulk(true)}>Delete {selected.size === 1 ? "1 file" : `${selected.size} files`}</Button>
              </>}
            </div>
          )}
          <DataTable label="Files" rowHeight="identity" columns={columns} hidden={t.hidden} isSelected={(f) => selected.has(f.name)} rows={t.rows} rowKey={(f) => f.name} loading={t.loading}
            sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
            error={t.loadError ? { title: "Couldn't load the files", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
            empty={t.state.q
              ? { icon: FolderIcon, title: "No files match", description: "Change the search, or clear it to see every file." }
              : { icon: FolderIcon, title: "No files yet", description: "Files appear here once someone uploads them or a system drops them into this folder." }}
            rowActions={(f) => (
              <ActionMenu label={`Actions for ${f.name}`} actions={[
                { id: "details", label: "View details", onSelect: () => setOpen(f) },
                { id: "download", label: "Download", onSelect: () => download(f) },
                ...(manage ? [{ id: "delete", label: "Delete file", destructive: true, disabled: read(f), hint: read(f) ? "A source has already read this file." : undefined, onSelect: () => setDel(f) }] : []),
              ]} />
            )} />
          </Panel>
        </div>}
      </FilterLayout>
      {bulk && <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setBulk(false); }} destructive auditFields={false} reasons={[]}
        title={`Delete ${selected.size === 1 ? "1 file" : `${selected.size} files`}`} description="Only files no source has read yet are deleted; any a source picked up meanwhile stay."
        impact={[...selected].slice(0, 5).map((n) => `${n} is removed from ${folder}/.`).concat(selected.size > 5 ? [`And ${selected.size - 5} more.`] : [])} actionLabel="Delete files"
        onConfirm={async () => {
          const r = await api<BulkResult>(`/api/spaces/${encodeURIComponent(spaceId)}/inbox/folders/${encodeURIComponent(folder)}/files/bulk-delete`, { method: "POST", body: JSON.stringify({ names: [...selected] }) });
          toast(r.skipped.length ? `Deleted ${r.done.length} of ${r.done.length + r.skipped.length} files. ${r.skipped.length === 1 ? "1 stays" : `${r.skipped.length} stay`}: a source has read it or it is gone.` : `Deleted ${r.done.length === 1 ? "1 file" : `${r.done.length} files`}.`);
          setSelected(new Set());
          await qc.invalidateQueries({ queryKey: INBOX_KEY });
          setBulk(false);
        }} />}
      {open && <FileDetailsDialog spaceId={spaceId} folder={folder} file={open} onClose={() => setOpen(null)} />}
      {del && <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setDel(null); }} destructive auditFields={false} reasons={[]}
        title={`Delete ${del.name}`} description="No source has read this file yet, so nothing else changes."
        impact={[`${del.name} is removed from ${folder}/.`]} actionLabel="Delete file"
        onConfirm={async () => {
          await api(`/api/spaces/${encodeURIComponent(spaceId)}/inbox/folders/${encodeURIComponent(folder)}/files?name=${encodeURIComponent(del.name)}`, { method: "DELETE" });
          toast(`Deleted ${del.name}.`);
          await qc.invalidateQueries({ queryKey: INBOX_KEY });
          setDel(null);
        }} />}
    </FilterSurface>
  );
}
