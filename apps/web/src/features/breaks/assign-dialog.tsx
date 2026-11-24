"use client";

import { mayDo } from "@starterkit/shared/spaces";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Select } from "@starterkit/ui/ui/select";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceMemberDto } from "@starterkit/shared/contracts/spaces";
import { api, errorText } from "@/lib/client/api";
import { SPACES_KEY } from "@/lib/shared/queries";

const NOBODY = "";

/**
 * Assign the selected breaks (loaded on demand: next/dynamic): to an active member of the space who works breaks
 * (operator, reviewer, space admin), or back to Unassigned. The space's members are read when it opens.
 */
export default function AssignDialog({ spaceId, count, onAssign, onClose }: {
  spaceId: string; count: number; onAssign: (assigneeId: string | null) => Promise<void>; onClose: () => void;
}) {
  const url = `/api/spaces/${encodeURIComponent(spaceId)}/members?pageSize=100`;
  const q = useQuery({ queryKey: [...SPACES_KEY, "members-for-breaks", spaceId], queryFn: () => api<Page<SpaceMemberDto>>(url) });
  const people = (q.data?.items ?? []).filter((m) => m.active && mayDo(m.roles, "work"));
  const [who, setWho] = useState(NOBODY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try { await onAssign(who || null); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign {count === 1 ? "1 item" : `${count} items`}</DialogTitle>
          <DialogDescription>Whoever you pick sees them under Mine. Unassigned puts them back in the queue.</DialogDescription>
        </DialogHeader>
        <DialogBody>
        <Field id="assign-to" label="Assign to" required error={q.error ? errorText(q.error) : error}>
          <Select id="assign-to" value={who} className="w-full" onChange={(e) => setWho(e.target.value)} disabled={q.isPending || busy}>
            <option value={NOBODY}>{q.isPending ? "Loading members…" : "Unassigned"}</option>
            {people.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </Select>
        </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => void go()} disabled={busy || q.isPending} aria-busy={busy || undefined}>
            {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{who ? "Assign items" : "Unassign items"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
