"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActionMenu } from "@starterkit/ui/ds";
import { toast } from "@starterkit/ui/ui/toast";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { SessionsTable } from "@/components/sessions-table";
import { TrustedDevicesPanel } from "@/components/trusted-devices-panel";
import { PageHeader } from "@/components/shell/page-header";
import { api } from "@/lib/client/api";
import type { SessionDto } from "@starterkit/shared/contracts/me";
import { MY_DEVICES, MY_SESSIONS } from "@/lib/shared/queries";
import { MeNav } from "./me-nav";

/**
 * /me/sessions: the signed-in user's own sessions (this one is marked; any other can be ended) and trusted devices
 * (DEC-065), each removable.
 */
export function MySessionsPage() {
  const qc = useQueryClient();
  const [ending, setEnding] = useState<SessionDto | null>(null);
  return (
    <div className="grid gap-section">
      <PageHeader title="Sessions" description="Where you're signed in now." />
      <MeNav />
      <SessionsTable table={MY_SESSIONS} title="My sessions" description="Where you're signed in" current="This session"
        emptyHint="Your sessions appear here after you sign in."
        action={(r) => r.current
          ? <span className="text-caption text-fg-3">Sign out from the account menu</span>
          : <ActionMenu label={`Actions for the session on ${r.device}`} actions={[{ id: "end", label: "End session", destructive: true, onSelect: () => setEnding(r) }]} />} />
      <TrustedDevicesPanel read={MY_DEVICES} revoke={(id) => `/api/me/devices/${encodeURIComponent(id)}`}
        description="Browsers that sign in with your one-time code only"
        emptyHint="Tick Trust this device when you enter your one-time code; the browser appears here for 30 days after its last use." />
      {/* Loaded on the first End session: the dialog stays out of the page's first load (AGENTS.md §9). */}
      {ending && <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setEnding(null); }} auditFields={false} reasons={[]}
        title="End this session" description={`${ending.device} · ${ending.ip}`}
        impact={["That device is signed out and must sign in again."]} actionLabel="End session" destructive
        onConfirm={async () => {
          await api(`/api/me/sessions/${encodeURIComponent(ending!.id)}`, { method: "DELETE" });
          toast(`Ended the session on ${ending!.device}.`);
          await qc.invalidateQueries({ queryKey: [MY_SESSIONS.key] }); // under "me": a password change refreshes it too
        }} />}
    </div>
  );
}
