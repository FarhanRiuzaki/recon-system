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

/** Opened on click only (route budget, AGENTS.md §9); the import starts on the first press or focus of its button. */
const loadDialog = () => import("./add-to-space-dialog");
const AddToSpaceDialog = dynamic(() => loadDialog().then((m) => m.AddToSpaceDialog), { ssr: false });
const preloadDialog = () => void loadDialog();

/**
 * The ids of the user's spaces when the whole list is loaded, else null: the add dialog offers only spaces the user is
 * not in, so it must know all of them (a PUT to a space they are in would replace their roles there).
 */
export function joinedSpaces(page: Page<UserSpaceDto> | undefined): string[] | null {
  if (!page || page.totalCapped || page.total > page.items.length) return null;
  return page.items.map((s) => s.spaceId);
}

const COLUMNS: Column<UserSpaceDto>[] = [
  { key: "name", header: "Space", mobile: "title", cell: (s) => <Link href={`/spaces/${encodeURIComponent(s.spaceId)}/members`} className="text-fg underline-offset-2 hover:underline">{s.name}</Link> },
  { key: "roles", header: "Roles in this space", mobile: "meta", cell: (s) => <RoleChips roles={s.roles.map((r) => ROLE_LABEL[r])} fallback="neutral" /> },
  { key: "status", header: "Status", mobile: "meta", cell: (s) => (s.status === "active" ? <StatusChip health="healthy" label="Active" /> : <StatusChip health="stopped" label="Archived" />) },
];

/**
 * The spaces a user is in with their roles there (space.view), each linking to the space's members; `canManage`
 * (space.manage) adds "Add to space". Changing or removing a membership stays on the Members page.
 */
export function UserSpaces({ user, canManage }: { user: { id: string; name: string }; canManage: boolean }) {
  const { key, url } = userSpaces(user.id);
  // ponytail: one page of 100 spaces (past that, no Add to space: joinedSpaces); page it when a user can be in more.
  const q = useQuery({ queryKey: key, queryFn: () => api<Page<UserSpaceDto>>(url) });
  /** The user's space ids when the dialog opened (kept if a refresh fails meanwhile); null = closed. */
  const [adding, setAdding] = useState<string[] | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const rows = q.data?.items ?? [];
  // Not while loading, after a failed refresh (the list may be out of date) or past the first page.
  const joined = q.error ? null : joinedSpaces(q.data);
  return (
    <Panel flush icon={SurfacesIcon} title="Spaces" description="Where this user works and their roles there" count={q.data?.total}
      actions={canManage && joined && (
        <Button ref={addButton} variant="secondary" size="sm" onPointerDown={preloadDialog} onFocus={preloadDialog} onClick={() => setAdding(joined)}>Add to space</Button>
      )}>
      {q.error && q.data && <Notice tone="warn" live>Couldn&apos;t refresh the spaces; showing the last loaded list.</Notice>}
      <DataTable label="Spaces" columns={COLUMNS} rows={rows} rowKey={(s) => s.spaceId} loading={q.isPending} skeletonRows={2}
        error={q.error && !q.data ? { title: "Couldn't load the spaces", cause: errorText(q.error), onRetry: () => void q.refetch() } : null}
        empty={{ icon: SurfacesIcon, title: "Not in any space yet", description: "Spaces appear here when someone adds this user to one." }} />
      {adding && (
        <AddToSpaceDialog user={user} joined={adding} onClose={() => setAdding(null)} returnFocus={() => addButton.current?.focus()} />
      )}
    </Panel>
  );
}
