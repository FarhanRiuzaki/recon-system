"use client";

// The Inbox files dialogs, loaded on click (route budget, AGENTS.md §9): create a folder, upload files, a file's details.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { activeElement, Facts, Field, focusBack, FileUpload, StatusChip, useForm } from "@starterkit/ui/ds";
import { formatBytes } from "@starterkit/ui/lib/format";
import { rules, type Schema } from "@starterkit/ui/lib/validate";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { ExportIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { toast } from "@starterkit/ui/ui/toast";
import type { InboxFileDto, InboxFolderDto } from "@starterkit/shared/contracts/inbox";
import { INBOX_FOLDER_NAME } from "@starterkit/shared/inbox";
import { api, errorText } from "@/lib/client/api";
import { STATE } from "./inbox-columns";
import { inboxFilesPath, uploadFile } from "./upload";
import { INBOX_KEY } from "./use-inbox";

type FolderValues = { name: string };
export const FOLDER_SCHEMA: Schema<FolderValues> = {
  name: [rules.required("Enter a folder name."), (v) => (INBOX_FOLDER_NAME.test(String(v).trim()) ? null : "Use lower case letters, digits, _ and -, starting with a letter or digit.")],
};

/** POST …/inbox/folders (source admin). */
export function CreateFolderDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const f = useForm<FolderValues>({ initial: { name: "" }, schema: FOLDER_SCHEMA, idPrefix: "folder" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opener] = useState(activeElement);
  const save = f.submit(async (v) => {
    setBusy(true);
    setError(null);
    try {
      const made = await api<InboxFolderDto>(`/api/spaces/${encodeURIComponent(spaceId)}/inbox/folders`, { method: "POST", body: JSON.stringify({ name: v.name.trim() }) });
      toast(`Created folder ${made.name}.`);
      await qc.invalidateQueries({ queryKey: INBOX_KEY });
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone="top" onCloseAutoFocus={(e) => { e.preventDefault(); focusBack(opener); }}>
        <form onSubmit={save} noValidate>
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription>Files are uploaded into a folder. Point a file source at it to read them.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <fieldset disabled={busy} className="grid min-w-0 gap-4">
              <Field id={f.id("name")} label="Folder name" required note="Lower case letters, digits, _ and -, e.g. act." error={f.error("name")}>
                <Input {...f.text("name")} autoComplete="off" autoFocus className="font-mono" />
              </Field>
              {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
            </fieldset>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="create-solid" disabled={busy} aria-busy={busy || undefined}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Create folder</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Drop or pick files; each is sent on its own (POST …/files) with its own progress and error. */
export function UploadDialog({ spaceId, folder, onClose }: { spaceId: string; folder: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [opener] = useState(activeElement);
  const [sent, setSent] = useState(0);
  const close = () => {
    if (sent) void qc.invalidateQueries({ queryKey: INBOX_KEY });
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent onCloseAutoFocus={(e) => { e.preventDefault(); focusBack(opener); }}>
        <DialogHeader>
          <DialogTitle>Upload files to {folder}/</DialogTitle>
          <DialogDescription>Each file lands in the folder once it is whole. A file with a name already in the folder is refused.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FileUpload label="Files" multiple
            upload={async (file, { onProgress }) => {
              await uploadFile(spaceId, folder, file);
              onProgress(1);
              setSent((n) => n + 1);
            }} />
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One file: size, times, uploader, sha-free facts, and what each reading source did with it; Download. */
export function FileDetailsDialog({ spaceId, folder, file, onClose }: { spaceId: string; folder: string; file: InboxFileDto; onClose: () => void }) {
  const [opener] = useState(activeElement);
  const download = `${inboxFilesPath(spaceId, folder)}/download?name=${encodeURIComponent(file.name)}`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent onCloseAutoFocus={(e) => { e.preventDefault(); focusBack(opener); }}>
        <DialogHeader>
          <DialogTitle className="break-all">{file.name}</DialogTitle>
          <DialogDescription>In {folder}/</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <Facts items={[
            ["Size", formatBytes(file.size)],
            ["Modified", new Date(file.modifiedAt).toLocaleString()],
            ["Uploaded by", file.uploadedBy ? `${file.uploadedBy.name}, ${new Date(file.uploadedAt!).toLocaleString()}` : "Not uploaded here (FTP or copied in)"],
          ]} />
          <div className="grid gap-2">
            <h3 className="text-label text-fg">Sources</h3>
            {file.sources.length ? file.sources.map((s) => (
              <div key={s.sourceId} className="flex flex-wrap items-center gap-2 text-body-sm">
                <StatusChip health={STATE[s.state].health} label={STATE[s.state].label} />
                <span className="text-fg">{s.sourceName}</span>
                {s.state === "ingested" && <span className="text-fg-3">{s.rowsIn} rows in{s.rowsQuarantined ? `, ${s.rowsQuarantined} quarantined` : ""}</span>}
              </div>
            )) : <p className="text-body-sm text-fg-3">No source reads this folder, or none matches this file name.</p>}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button asChild variant="secondary"><a href={download} download><Icon icon={ExportIcon} />Download</a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
