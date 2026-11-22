"use client";

import { useState } from "react";
import { Field, Notice, Panel } from "@starterkit/ui/ds";
import { formatDateTime } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Textarea } from "@starterkit/ui/ui/textarea";

type Open = { version: number; submittedBy: { name: string | null } | null; submittedAt: string | null };

/**
 * A version waiting for approval (a library workflow's or a space's approval rules'): publish it or send it back with a
 * comment; a Superadmin's own only by override, with a reason; `blocked` says why the viewer can't decide it.
 */
export function ReviewPanel({ open, blocked, overrideOnly, busy, onDecide }: {
  open: Open; blocked: string | null; overrideOnly: boolean; busy: string | null;
  onDecide: (how: "approve" | "reject", body: { comment?: string; override?: true }) => Promise<boolean>;
}) {
  const [comment, setComment] = useState("");
  const decide = async (how: "approve" | "reject") => {
    const c = comment.trim();
    if (await onDecide(how, { ...(c ? { comment: c } : {}), ...(how === "approve" && overrideOnly ? { override: true as const } : {}) })) setComment("");
  };
  return (
    <Panel title={`Version ${open.version} waits for approval`} description={`Sent by ${open.submittedBy?.name ?? "a removed user"}${open.submittedAt ? ` · ${formatDateTime(Date.parse(open.submittedAt))}` : ""}`}>
      {blocked ? <p className="text-body-sm text-fg-3">{blocked}</p> : (
        <div className="grid gap-3 md:max-w-xl">
          <Field id="review-comment" label={overrideOnly ? "Reason for the override" : "Comment (optional to publish, required to send back)"} required={overrideOnly}>
            <Textarea id="review-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={overrideOnly ? "Why you publish your own version" : "What you checked"} />
          </Field>
          {overrideOnly && <Notice>You made this version. As Superadmin you can publish it only by override, with a reason; it is recorded.</Notice>}
          <span className="flex flex-wrap gap-2">
            <Button type="button" disabled={!!busy || (overrideOnly && !comment.trim())} aria-busy={busy === "approve" || undefined} onClick={() => void decide("approve")}>
              {busy === "approve" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{overrideOnly ? "Publish by override" : "Publish version"}
            </Button>
            {!overrideOnly && (
              <Button type="button" variant="secondary" disabled={!!busy || !comment.trim()} aria-busy={busy === "reject" || undefined} onClick={() => void decide("reject")}>Send back</Button>
            )}
          </span>
        </div>
      )}
    </Panel>
  );
}
