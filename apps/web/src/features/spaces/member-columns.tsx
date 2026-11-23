import type { ReactNode } from "react";
import { type Column, RelativeTime, StatusChip, Truncate } from "@starterkit/ui/ds";
import type { SpaceMemberDto } from "@starterkit/shared/contracts/spaces";
import { SpaceRoleChips } from "@/components/role-chips";
import { statusTone } from "@/lib/shared/categories";

/**
 * Columns of a space's members (audit §5.6): member, role chips, status, last sign-in; the username hidden until chosen
 * (and off the phone card). Tablet (768–1279) hides Last sign-in. Only the name sorts (the API's SPACE_MEMBER_SORTS).
 */
export const MEMBER_COLUMNS: Column<SpaceMemberDto>[] = [
  { key: "name", header: "Member", sortable: true, mobile: "title", className: "min-w-48", cell: (m) => <Truncate title={m.name}><span className="font-medium text-fg">{m.name}</span></Truncate> },
  { key: "roles", header: "Roles in this space", cell: (m) => <SpaceRoleChips roles={m.roles} /> },
  { key: "status", header: "Status", cell: (m) => (m.active ? <StatusChip health={statusTone("active")} label="Active" /> : <StatusChip health={statusTone("inactive")} label="Inactive" />) },
  { key: "lastSignInAt", header: "Last sign-in", className: "md:max-xl:hidden", cell: (m): ReactNode =>
    (m.lastSignInAt ? <RelativeTime at={Date.parse(m.lastSignInAt)} /> : <span className="text-fg-3">Never</span>) },
  { key: "username", header: "Username", mobile: "hidden", defaultHidden: true, cell: (m) => <span className="font-mono text-body-sm">{m.username}</span> },
];
