"use client";

import { useId } from "react";
import { Checkbox } from "@starterkit/ui/ds";
import { ROLE_DESCRIPTION, ROLE_LABEL, SPACE_ROLES, type SpaceRole } from "@starterkit/shared/spaces";
import { LAST_SPACE_ADMIN, SOURCE_ADMIN_REASON } from "./use-spaces";

type Locks = { canSourceAdmin: boolean; lockedSpaceAdmin: boolean };


/** The reason `role` can't be toggled, or null. */
const lockOf = (role: SpaceRole, l: Locks): string | null =>
  role === "source_admin" && !l.canSourceAdmin ? SOURCE_ADMIN_REASON : role === "space_admin" && l.lockedSpaceAdmin ? LAST_SPACE_ADMIN : null;

/** `value` with `role` toggled, in SPACE_ROLES order; a locked role stays as it is, so the PUT never changes it. */
export function toggleRole(value: readonly SpaceRole[], role: SpaceRole, l: Locks): SpaceRole[] {
  if (lockOf(role, l)) return [...value];
  return SPACE_ROLES.filter((r) => (r === role ? !value.includes(r) : value.includes(r)));
}

/**
 * The seven space roles with their descriptions (Figma 01 Dialog/Change roles). Source admin is read-only without
 * space.manage (`canSourceAdmin`), its reason as text under it, checked when already held; Space admin is read-only
 * when `lockedSpaceAdmin` (the member is the space's only active space admin; the dialog says why in full).
 */
export function RoleChecklist({ legend, value, onChange, canSourceAdmin, lockedSpaceAdmin }: {
  legend: string; value: readonly SpaceRole[]; onChange: (roles: SpaceRole[]) => void; canSourceAdmin: boolean; lockedSpaceAdmin: boolean;
}) {
  const locks = { canSourceAdmin, lockedSpaceAdmin };
  const ids = useId();
  return (
    <fieldset className="grid min-w-0 gap-3">
      <legend className="mb-3 text-label text-fg">{legend}</legend>
      {SPACE_ROLES.map((role) => {
        const reason = lockOf(role, locks);
        const id = `${ids}-${role}`;
        return (
          <div key={role} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2">
            <Checkbox id={id} label={ROLE_LABEL[role]} checked={value.includes(role)} reason={reason ?? undefined} onToggle={() => onChange(toggleRole(value, role, locks))} />
            <label htmlFor={id} className={reason ? "grid gap-0.5 pt-1 text-fg-3" : "grid cursor-pointer gap-0.5 pt-1"}>
              <span className="text-body">{ROLE_LABEL[role]}</span>
              <span className="text-caption text-fg-3">{ROLE_DESCRIPTION[role]}</span>
              {role === "source_admin" && reason && <span aria-hidden="true" className="text-caption text-fg-2">{reason}</span>}
            </label>
          </div>
        );
      })}
      <p className="text-caption text-fg-3">Someone can hold a maker and a checker role together. They still can&apos;t approve their own requests.</p>
    </fieldset>
  );
}
