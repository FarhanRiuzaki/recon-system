"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Select } from "@starterkit/ui/ui/select";
import { toast } from "@starterkit/ui/ui/toast";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceRole, SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { RoleChecklist } from "@/components/role-checklist";
import { api, errorText } from "@/lib/client/api";
import { spaceOptions, SPACES_KEY } from "@/lib/shared/queries";
import { membershipProblems } from "@/lib/shared/membership";

/**
 * Add a user to a space from their page (space.manage): a space they are not in yet (`joined` = the ones they are)
 * and their roles there, Source admin included; one PUT for that membership. A failure stays in the dialog.
 */
export function AddToSpaceDialog({ user, joined, onClose, returnFocus }: {
  user: { id: string; name: string }; joined: readonly string[]; onClose: () => void; returnFocus: () => void;
}) {
  const qc = useQueryClient();
  const { key, url } = spaceOptions();
  // ponytail: the first 100 spaces by name, as the switcher lists them; search when an app has more.
  const all = useQuery({ queryKey: key, queryFn: () => api<Page<SpaceRowDto>>(url) });
  const open = all.data?.items.filter((s) => !joined.includes(s.id)) ?? [];
  const [spaceId, setSpaceId] = useState("");
  const [roles, setRoles] = useState<SpaceRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const space = open.find((s) => s.id === spaceId);
  // the same rule and words as Add member on a space's page: the submit stays on, a press says what is missing
  const [tried, setTried] = useState(false);
  const problems = tried ? membershipProblems({ target: space, roles }, "space") : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!space || membershipProblems({ target: space, roles }, "space")) { setTried(true); if (!space) document.getElementById("add-to-space-space")?.focus(); return; }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/spaces/${encodeURIComponent(space.id)}/members/${encodeURIComponent(user.id)}`, { method: "PUT", body: JSON.stringify({ roles }) });
      // Refreshed before closing (this panel, the members tables, the switcher), so a reopened dialog no longer offers this space.
      await qc.invalidateQueries({ queryKey: SPACES_KEY });
      toast(`Added ${user.name} to ${space.name}.`);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const note = all.isPending ? "Loading spaces…" : all.data && open.length === 0 ? `${user.name} is already in every space.` : undefined;
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[minmax(0,1fr)]" onCloseAutoFocus={(e) => { e.preventDefault(); returnFocus(); }}>
        <form noValidate className="flex min-h-0 flex-col" onSubmit={(e) => void submit(e)}>
          <DialogHeader className="shrink-0">
            <DialogTitle>{`Add ${user.name} to a space`}</DialogTitle>
            <DialogDescription>Roles apply to the space you pick only. Change or remove them later on the space&apos;s Members page.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <fieldset disabled={busy} className="grid min-w-0 gap-4">
            <Field id="add-to-space-space" label="Space" required note={note} error={problems?.target}>
              <Select id="add-to-space-space" value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={open.length === 0}>
                <option value="" disabled>Pick a space</option>
                {open.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            {all.error && (
              <p role="alert" className="text-body-sm text-down-ink">
                Couldn&apos;t load the spaces. <button type="button" className="underline" onClick={() => void all.refetch()}>Try again</button>
              </p>
            )}
            <RoleChecklist legend={space ? `Roles in ${space.name}` : "Roles"} value={roles} onChange={setRoles} canSourceAdmin lockedSpaceAdmin={false} />
            {problems?.roles && <p role="alert" className="text-body-sm text-down-ink">{problems.roles}</p>}
            {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
          </fieldset>
          </DialogBody>
          <DialogFooter className="shrink-0">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="create-solid" disabled={busy} aria-busy={busy || undefined}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Add to space</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
