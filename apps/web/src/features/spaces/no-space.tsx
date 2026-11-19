"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { CopyValue } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon, UsersIcon } from "@starterkit/ui/ui/icons";
import { api } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";

const CreateSpaceDialog = dynamic(() => import("./create-space-dialog").then((m) => m.CreateSpaceDialog), { ssr: false });

/**
 * /spaces for a user who belongs to no space: who adds them and the username to send. A holder of `space.manage` can
 * create a space here instead. The empty state sits in a tray in the content (Figma "Shell · No space yet").
 */
export function NoSpace() {
  const { user, can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [leaving, setLeaving] = useState(false);
  async function signOut() {
    setLeaving(true);
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard navigation clears client caches
    window.location.assign("/login");
  }
  return (
    <div className="grid justify-items-center pt-16 max-md:pt-6">
      <div className="w-full max-w-120 rounded-xl bg-tray p-1">
        <section aria-labelledby="no-space-title" className="grid justify-items-center gap-2 rounded-lg bg-card px-6 py-10 text-center shadow-xs">
          <span className="mb-1 grid size-10 place-items-center rounded-full bg-tray text-fg-3"><Icon icon={UsersIcon} className="size-5" /></span>
          <h1 id="no-space-title" className="text-title-3 text-fg">You&apos;re not a member of any space yet</h1>
          <p className="max-w-[44ch] text-body-sm text-fg-2">
            A space admin of your team adds you to their space. If your team has no space yet, a platform admin creates one. Send them your username:
          </p>
          <CopyValue value={user.username} label="username" />
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {can("space.manage") && <Button onClick={() => setCreating(true)}>Create space</Button>}
            <Button variant="secondary" onClick={signOut} disabled={leaving} aria-busy={leaving || undefined}>
              {leaving && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Sign out
            </Button>
          </div>
        </section>
      </div>
      {creating && <CreateSpaceDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
