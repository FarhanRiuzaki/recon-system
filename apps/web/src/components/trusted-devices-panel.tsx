"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActionMenu, type Column, DataTable, Notice, Panel, RelativeTime } from "@starterkit/ui/ds";
import { SecureIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { Page } from "@starterkit/shared/contracts/common";
import type { TrustedDeviceDto } from "@starterkit/shared/contracts/me";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { api, errorText } from "@/lib/client/api";

const COLUMNS: Column<TrustedDeviceDto>[] = [
  { key: "label", header: "Device", mobile: "title", cell: (d) => <span className="font-medium text-fg">{d.label}</span> },
  { key: "ip", header: "IP address", mobile: "meta", cell: (d) => <span className="font-mono text-mono">{d.ip}</span> },
  { key: "lastUsedAt", header: "Last used", mobile: "meta", cell: (d) => <RelativeTime at={Date.parse(d.lastUsedAt)} /> },
  { key: "expiresAt", header: "Trust ends", mobile: "hidden", cell: (d) => <RelativeTime at={Date.parse(d.expiresAt)} /> },
];

/**
 * One user's trusted devices (DEC-065): browsers that sign in with the one-time code only. At most 5 per user, so one
 * page (`read`, prefetched by the page) holds them all. `revoke`: the DELETE path of a device, or null when the viewer
 * may not revoke; `blocked` disables Remove with its reason (actor rank).
 */
export function TrustedDevicesPanel({ read, revoke, blocked, description, emptyHint, enabled = true }: {
  read: { key: readonly unknown[]; url: string };
  revoke: ((id: string) => string) | null;
  blocked?: string | null;
  description: string;
  emptyHint: string;
  enabled?: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: read.key, queryFn: () => api<Page<TrustedDeviceDto>>(read.url), enabled });
  const [removing, setRemoving] = useState<TrustedDeviceDto | null>(null);
  return (
    <Panel flush icon={SecureIcon} title="Trusted devices" description={description} count={q.data?.total}>
      {q.error && q.data && <Notice tone="warn" live>Couldn&apos;t refresh the trusted devices; showing the last loaded list.</Notice>}
      <DataTable label="Trusted devices" columns={COLUMNS} rows={q.data?.items ?? []} rowKey={(d) => d.id} loading={q.isPending && enabled} skeletonRows={2}
        rowActions={revoke ? (d) => <ActionMenu label={`Actions for the trusted device ${d.label}`}
          actions={[{ id: "remove", label: "Remove trust", destructive: true, disabled: !!blocked, hint: blocked ?? undefined, onSelect: () => setRemoving(d) }]} /> : undefined}
        error={q.error && !q.data ? { title: "Couldn't load the trusted devices", cause: errorText(q.error), onRetry: () => void q.refetch() } : null}
        empty={{ icon: SecureIcon, title: "No trusted devices", description: emptyHint }} />
      {/* Loaded on the first Remove trust: the dialog stays out of the page's first load (AGENTS.md §9). */}
      {removing && revoke && <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setRemoving(null); }} auditFields={false} reasons={[]}
        title="Remove this trusted device" description={`${removing.label} · ${removing.ip}`}
        impact={["The next sign-in on that browser asks for the password again.", "Sessions already signed in there stay signed in."]}
        actionLabel="Remove trust" destructive
        onConfirm={async () => {
          await api(revoke(removing!.id), { method: "DELETE" });
          toast(`Removed the trust of ${removing!.label}.`);
          await qc.invalidateQueries({ queryKey: read.key });
        }} />}
    </Panel>
  );
}
