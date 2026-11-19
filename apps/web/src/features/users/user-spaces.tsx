"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef, useState } from "react";
import { type Column, DataTable, Notice, Panel, StatusChip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { SurfacesIcon } from "@starterkit/ui/ui/icons";
import type { Page } from "@starterkit/shared/contracts/common";
import type { UserSpaceDto } from "@starterkit/shared/contracts/spaces";
import { ROLE_LABEL } from "@starterkit/shared/spaces";
import { RoleChips } from "@/components/role-chips";
import { api, errorText } from "@/lib/client/api";
import { userSpaces } from "@/lib/shared/queries";

/** Opened on click only (route budget, AGENTS.md §9). */
const AddToSpaceDialog = dynamic(() => import("./add-to-space-dialog").then((m) => m.AddToSpaceDialog), { ssr: false });

const COLUMNS: Column<UserSpaceDto>[] = [
  { key: "name", header: "Space", mobile: "title", cell: (s) => <Link href={`/spaces/${encodeURIComponent(s.spaceId)}/members`} className="text-fg underline-offset-2 hover:underline">{s.name}</Link> },
  { key: "roles", header: "Roles in this space", mobile: "meta", cell: (s) => <RoleChips roles={s.roles.map((r) => ROLE_LABEL[r])} /> },
  { key: "status", header: "Status", mobile: "meta", cell: (s) => (s.status === "active" ? <StatusChip health="healthy" label="Active" /> : <StatusChip health="stopped" label="Archived" />) },
];

/**
 * The spaces a user is in with their roles there (space.view), each linking to the space's members; `canManage`
 * (space.manage) adds "Add to space". Changing or removing a membership stays on the Members page.
 */
export function UserSpaces({ user, canManage }: { user: { id: string; name: string }; canManage: boolean }) {
  const { key, url } = userSpaces(user.id);
  // ponytail: one page of 100 spaces; page it when a user can be in more.
  const q = useQuery({ queryKey: key, queryFn: () => api<Page<UserSpaceDto>>(url) });
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const rows = q.data?.items ?? [];
  return (
    <Panel flush icon={SurfacesIcon} title="Spaces" description="Where this user works and their roles there" count={q.data?.total}
      actions={canManage && <Button ref={addButton} variant="secondary" size="sm" onClick={() => setAdding(true)}>Add to space</Button>}>
      {q.error && q.data && <Notice tone="warn" live>Couldn&apos;t refresh the spaces; showing the last loaded list.</Notice>}
      <DataTable label="Spaces" columns={COLUMNS} rows={rows} rowKey={(s) => s.spaceId} loading={q.isPending} skeletonRows={2}
        error={q.error && !q.data ? { title: "Couldn't load the spaces", cause: errorText(q.error), onRetry: () => void q.refetch() } : null}
        empty={{ icon: SurfacesIcon, title: "Not in any space yet", description: "Spaces appear here when someone adds this user to one." }} />
      {adding && (
        <AddToSpaceDialog user={user} joined={rows.map((s) => s.spaceId)} onClose={() => setAdding(false)} returnFocus={() => addButton.current?.focus()} />
      )}
    </Panel>
  );
}
