// What a new space membership needs before its PUT (SetSpaceMemberBody: 1–7 roles), the same on both screens that add
// one: Add member on a space's members page (`person`) and Add to space on a user's page (`space`). Pure.

/**
 * Why the membership can't be added yet, per control, or null when it can: no person or space picked, no role. The
 * submit stays on; a press with something missing shows these beside their controls.
 */
export function membershipProblems(v: { target: unknown; roles: readonly unknown[] }, pick: "person" | "space"): { target: string | null; roles: string | null } | null {
  const target = v.target ? null : `Pick a ${pick}.`;
  const roles = v.roles.length ? null : "Pick at least one role.";
  return target || roles ? { target, roles } : null;
}
