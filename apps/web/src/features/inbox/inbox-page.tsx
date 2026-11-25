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
import type { InboxFileDto } from "@starterkit/shared/contracts/inbox";
import { mayDo } from "@starterkit/shared/spaces";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { PageHeader } from "@/components/shell/page-header";
import { api, ApiError, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { INBOX_FILES } from "@/lib/shared/queries";
import { FILE_COLUMNS, folderColumns, STATE_LEGEND } from "./inbox-columns";
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
  const upload = mayDo(roles, "uploadInbox"), manage = mayDo(roles, "manageInbox");
  const name = space?.name ?? "";
  const trail = folder ? [{ label: "Inbox files", href: folderHref(spaceId, null) }] : [];
  return (
    <div className="grid gap-section" onPointerDown={preload} onFocus={preload}>
      <PageHeader title={folder ? `${folder}/` : "Inbox files"} trail={trail}
        description={folder ? `Files in ${name} / ${folder}/. A file source pointed at this folder reads them.` : `Folders of the ${name} space. Upload a file into a folder; a file source pointed at the folder reads it.`}
        actions={folder
          ? <BlockedButton reason={upload ? null : UPLOAD_REASON} onClick={() => setDialog("upload")}><Icon icon={UploadIcon} />Upload files</BlockedButton>
          : (manage ? <Button variant="create" onClick={() => setDialog("folder")}><Icon icon={AddIcon} />Create folder</Button> : undefined)} />
      {folder ? <FilesView spaceId={spaceId} folder={folder} name={name} manage={manage} /> : <FoldersView spaceId={spaceId} name={name} manage={manage} />}
      {dialog === "folder" && <CreateFolderDialog spaceId={spaceId} onClose={() => setDialog(null)} />}
      {dialog === "upload" && folder && <UploadDialog spaceId={spaceId} folder={folder} onClose={() => setDialog(null)} />}
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

function FilesView({ spaceId, folder, name, manage }: { spaceId: string; folder: string; name: string; manage: boolean }) {
  const t = useTableQuery<InboxFileDto, { q: string }>(INBOX_FILES(spaceId, folder));
  const qc = useQueryClient();
  const [open, setOpen] = useState<InboxFileDto | null>(null);
  const [del, setDel] = useState<InboxFileDto | null>(null);
  const read = (f: InboxFileDto) => f.sources.some((s) => s.state !== "waiting");
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
        {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={FILE_COLUMNS} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
          flush icon={FolderIcon} title={<Crumbs spaceId={spaceId} name={name} folder={folder} />} count={t.count} legend={STATE_LEGEND}>
          {summary}
          <DataTable label="Files" rowHeight="identity" columns={FILE_COLUMNS} hidden={t.hidden} rows={t.rows} rowKey={(f) => f.name} loading={t.loading}
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
        </Panel>}
      </FilterLayout>
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
