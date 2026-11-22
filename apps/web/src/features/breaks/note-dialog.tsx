"use client";

import { useRef, useState } from "react";
import { Field, focusBack } from "@starterkit/ui/ds";
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
 * Once it was sent the page has changed (the opener may be gone): focus lands on the first of `landing` there, else the
 * page's h1; a cancel returns to the opener.
 */
export default function NoteDialog({ title, description, action, optional = false, placeholder, onSubmit, onClose, landing = [] }: {
  title: string; description: string; action: string; optional?: boolean; placeholder: string;
  onSubmit: (note: string) => Promise<void>; onClose: () => void; landing?: readonly string[];
}) {
  const sent = useRef(false);
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
    // set before the call: a page that closes the dialog inside onSubmit unmounts it before the call returns
    sent.current = true;
    try { await onSubmit(note.trim()); } catch (e) { sent.current = false; setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone="top" onCloseAutoFocus={(e) => { if (!sent.current) return; e.preventDefault(); focusBack(null, document, { skipOrigin: true, fallbacks: landing }); }}>
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
