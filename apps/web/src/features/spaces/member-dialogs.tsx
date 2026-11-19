"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useCallback, useState } from "react";
import { type ComboOption, Combobox, ConfirmActionDialog, Field } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceCandidateDto, SpaceMemberDto, SpaceRole } from "@starterkit/shared/contracts/spaces";
import { RoleChecklist } from "@/components/role-checklist";
import { api, errorText } from "@/lib/client/api";
import { spaceCandidates } from "@/lib/shared/queries";
import { SPACES_KEY } from "./use-spaces";

type Space = { id: string; name: string };
const memberUrl = (spaceId: string, userId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`;
const ERROR = "text-body-sm text-down-ink";

/** PUT the member's whole role set, then refresh everything under "spaces" (the members table, candidates, the caller's own roles). */
function useSetRoles(space: Space) {
  const qc = useQueryClient();
  return async (userId: string, roles: SpaceRole[]) => {
    await api(memberUrl(space.id, userId), { method: "PUT", body: JSON.stringify({ roles }) });
    await qc.invalidateQueries({ queryKey: SPACES_KEY });
  };
}

/** A role dialog: title, description, the fields, an inline failure beside the submit, Cancel and the submit button. */
function RolesDialog({ title, description, phone, busy, error, submitLabel, canSubmit, onClose, onSubmit, returnFocus, children }: {
  title: string; description: string; phone?: "top"; busy: boolean; error: string | null; submitLabel: string; canSubmit: boolean;
  onClose: () => void; onSubmit: () => void; returnFocus: () => void; children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone={phone} className="max-h-[calc(100dvh-2rem)] grid-rows-[minmax(0,1fr)]" onCloseAutoFocus={(e) => { e.preventDefault(); returnFocus(); }}>
        <form noValidate className="flex min-h-0 flex-col" onSubmit={(e: FormEvent) => { e.preventDefault(); if (canSubmit && !busy) onSubmit(); }}>
          <DialogHeader className="shrink-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <fieldset disabled={busy} className="scroll-quiet grid min-h-0 gap-4 overflow-y-auto px-6 pt-0.75 pb-5">
            {children}
            {error && <p role="alert" className={ERROR}>{error}</p>}
          </fieldset>
          <DialogFooter className="shrink-0">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !canSubmit} aria-busy={busy || undefined}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Runs `fn` with the dialog busy; a failure stays in the dialog (the API's 403 / 409 message). */
function useRun(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/**
 * Change roles (Figma 01 Dialog/Change roles): Save roles is off until the set changes; no role picked → the inline
 * reason, and Save stays off; `lockedSpaceAdmin` → the full "only space admin" line under the roles.
 */
export function ChangeRolesDialog({ space, member, canSourceAdmin, lockedSpaceAdmin, onClose, returnFocus }: {
  space: Space; member: SpaceMemberDto; canSourceAdmin: boolean; lockedSpaceAdmin: boolean; onClose: () => void; returnFocus: () => void;
}) {
  const [roles, setRoles] = useState<SpaceRole[]>(member.roles);
  const setMember = useSetRoles(space);
  const { busy, error, run } = useRun(onClose);
  const none = roles.length === 0;
  const changed = roles.join() !== member.roles.join(); // both in SPACE_ROLES order
  return (
    <RolesDialog title={`Change roles for ${member.name}`} description={`Roles apply to the ${space.name} space only.`} busy={busy} error={error}
      submitLabel="Save roles" canSubmit={changed && !none} onClose={onClose} returnFocus={returnFocus}
      onSubmit={() => void run(async () => { await setMember(member.userId, roles); toast(`Changed the roles of ${member.name}.`); })}>
      <RoleChecklist legend={`Roles in ${space.name}`} value={roles} onChange={setRoles} canSourceAdmin={canSourceAdmin} lockedSpaceAdmin={lockedSpaceAdmin} />
      {lockedSpaceAdmin && (
        <p className="text-body-sm text-fg-2">
          Space admin can&apos;t be removed: {member.name} is the only space admin, and a space needs at least one. Make someone else a space admin first.
        </p>
      )}
      {none && <p role="alert" className={ERROR}>Pick at least one role. To take {member.name} out of this space, use Remove from space.</p>}
    </RolesDialog>
  );
}

/**
 * Add member (Figma 01 Dialog/Add member): a person from the app's users (GET …/candidates; members are marked and
 * can't be picked) and their roles; Add member is off until both are chosen; one PUT for that user.
 */
export function AddMemberDialog({ space, canSourceAdmin, onClose, returnFocus }: { space: Space; canSourceAdmin: boolean; onClose: () => void; returnFocus: () => void }) {
  const qc = useQueryClient();
  const [person, setPerson] = useState<ComboOption | null>(null);
  const [roles, setRoles] = useState<SpaceRole[]>([]);
  const setMember = useSetRoles(space);
  const { busy, error, run } = useRun(onClose);
  const loadOptions = useCallback(async (q: string, signal: AbortSignal) => {
    const { key, url } = spaceCandidates(space.id, q);
    const page = await qc.fetchQuery({ queryKey: key, queryFn: () => api<Page<SpaceCandidateDto>>(url, { signal }) });
    return page.items.map((c) => ({ value: c.userId, label: c.name, description: c.member ? `${c.username} (already a member)` : c.username, disabled: c.member }));
  }, [qc, space.id]);
  return (
    <RolesDialog title={`Add a member to ${space.name}`} phone="top" busy={busy} error={error}
      description="People sign in with their bank directory account. Only people who have signed in once can be found."
      submitLabel="Add member" canSubmit={!!person && roles.length > 0} onClose={onClose} returnFocus={returnFocus}
      onSubmit={() => void run(async () => { await setMember(person!.value, roles); toast(`Added ${person!.label} to ${space.name}.`); })}>
      <Field id="add-member-person" label="Person">
        <Combobox id="add-member-person" label="Person" placeholder="Name or username" value={person} onChange={setPerson} loadOptions={loadOptions}
          emptyText="No one matches. Try another name or username." />
      </Field>
      <RoleChecklist legend={`Roles in ${space.name}`} value={roles} onChange={setRoles} canSourceAdmin={canSourceAdmin} lockedSpaceAdmin={false} />
    </RolesDialog>
  );
}

/** Remove from space: destructive confirm; the API's 403 / 409 stays in the dialog. Breaks and approvals come in Plan 5. */
export function RemoveMemberDialog({ space, member, onClose, onRemoved, returnFocus }: {
  space: Space; member: SpaceMemberDto; onClose: () => void; onRemoved: () => void; returnFocus: () => void;
}) {
  const qc = useQueryClient();
  async function remove() {
    try {
      await api(memberUrl(space.id, member.userId), { method: "DELETE" });
    } catch (err) {
      throw new Error(errorText(err));
    }
    toast(`Removed ${member.name} from ${space.name}.`);
    onRemoved();
    await qc.invalidateQueries({ queryKey: SPACES_KEY });
  }
  return (
    <ConfirmActionDialog open onOpenChange={(o) => { if (!o) onClose(); }} auditFields={false} reasons={[]} destructive impact={[]}
      title={`Remove ${member.name} from ${space.name}?`}
      description={`${member.name} loses access to ${space.name} right away. ${member.name}'s past actions stay in the activity log.`}
      actionLabel="Remove from space" onConfirm={remove} onCloseAutoFocus={(e) => { e.preventDefault(); returnFocus(); }} />
  );
}
