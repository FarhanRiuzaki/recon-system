"use client";

import { useState } from "react";
import { Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { RESOLUTION_NOTE_MAX } from "@starterkit/shared/recon";
import { errorText } from "@/lib/client/api";

/**
 * A change of a break with a note (loaded on demand: next/dynamic): asking a checker for a force match, unmatch or
 * write-off, or a checker's approve / reject. The note is required unless `optional`; a failure stays in the dialog.
 */
export default function NoteDialog({ title, description, action, optional = false, placeholder, onSubmit, onClose }: {
  title: string; description: string; action: string; optional?: boolean; placeholder: string;
  onSubmit: (note: string) => Promise<void>; onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = !optional && !note.trim();
  const go = async () => {
    setTried(true);
    if (missing) return;
    setBusy(true);
    setError(null);
    try { await onSubmit(note.trim()); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone="top">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
        <Field id="request-note" label={optional ? "Note (optional)" : "Note"} required={!optional} error={tried && missing ? "Say why." : error}>
          <Textarea id="request-note" value={note} limit={RESOLUTION_NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} placeholder={placeholder} disabled={busy} />
        </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => void go()} disabled={busy} aria-busy={busy || undefined}>
            {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
