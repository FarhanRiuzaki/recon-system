import type { ReactNode } from "react";
import { type Column, RelativeTime, StatusChip, Truncate } from "@starterkit/ui/ds";
import { ROLE_LABEL } from "@starterkit/shared/spaces";
import type { SpaceMemberDto } from "@starterkit/shared/contracts/spaces";
import { RoleChips } from "@/components/role-chips";

/**
 * Columns of a space's members (Figma "Build notes · 01 Space & shell"). Phone card: the member is the title, roles,
 * status and last sign-in are lines under it, the username stays off. Tablet (768–1279) hides Username and Last
 * sign-in. Only the name sorts (the API's SPACE_MEMBER_SORTS).
 */
export const MEMBER_COLUMNS: Column<SpaceMemberDto>[] = [
  { key: "name", header: "Member", sortable: true, mobile: "title", className: "min-w-48", cell: (m) => <Truncate title={m.name}><span className="font-medium text-fg">{m.name}</span></Truncate> },
  { key: "roles", header: "Roles in this space", cell: (m) => <RoleChips roles={m.roles.map((r) => ROLE_LABEL[r])} fallback="neutral" /> },
  { key: "status", header: "Status", cell: (m) => (m.active ? <StatusChip health="healthy" label="Active" /> : <StatusChip health="stopped" label="Inactive" />) },
  { key: "username", header: "Username", mobile: "hidden", className: "max-xl:hidden", cell: (m) => <span className="font-mono text-body-sm">{m.username}</span> },
  { key: "lastSignInAt", header: "Last sign-in", className: "md:max-xl:hidden", cell: (m): ReactNode =>
    (m.lastSignInAt ? <RelativeTime at={Date.parse(m.lastSignInAt)} /> : <span className="text-fg-3">Never</span>) },
];
