"use client";

import { type ChangeEvent, type ReactNode, useState } from "react";
import { BlockedButton, Field, Panel } from "@starterkit/ui/ds";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { REVIEW_COMMENT_MAX } from "@starterkit/shared/sources";
import { errorText } from "@/lib/client/api";

/**
 * A version page (ui-standard §1a "Version": a source version, a recon version), always in this order: the header,
 * the page notice (sent back), the decision for a version in review (first under the header), the changes from the
 * version before, the settings of this version, the preview or simulation. Values are text, never disabled inputs.
 */
export function VersionLayout({ header, notice, decision, changes, settings, preview }: {
  header: ReactNode; notice?: ReactNode; decision?: ReactNode; changes?: ReactNode; settings?: ReactNode; preview?: ReactNode;
}) {
  return <div className="grid gap-section">{header}{notice}{decision}{changes}{settings}{preview}</div>;
}

/** Label / value rows: a version's settings as text. */
export function ValueRows({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid gap-2">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-3 border-b border-line pb-2 last:border-b-0 last:pb-0">
          <dt className="w-36 shrink-0 text-label text-fg">{label}</dt>
          <dd className="min-w-0 text-body-sm wrap-anywhere text-fg-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Your decision" on a version in review: Approve and Reject as BlockedButtons saying who may act (maker ≠ checker);
 * a comment is required to reject. `onDecide` sends it; its error (409 self_approval / invalid_state) shows beside the
 * buttons. Someone who can't decide sees why, and the Approve button off with that reason.
 */
export function VersionDecision({ id, version, mine, approveWhy, rejectWhy, effect, onDecide }: {
  /** The comment field's id. */
  id: string; version: number;
  /** The viewer made, sent or worked on this version. */
  mine: boolean; approveWhy: string | null; rejectWhy: string | null;
  /** What approving does, one sentence ("Approving publishes version 2. …"). */
  effect: string;
  onDecide: (act: "approve" | "reject", comment: string) => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);

  if (approveWhy) {
    return (
      <Panel title="Your decision" bodyClassName="grid gap-3">
        <p className="text-body-sm text-fg-2">{mine ? "A config checker other than you approves or rejects this version." : "A config checker of this space approves or rejects this version."}</p>
        <span><BlockedButton reason={approveWhy}>Approve version {version}</BlockedButton></span>
      </Panel>
    );
  }

  async function decide(act: "approve" | "reject") {
    setError(null);
    if (act === "reject" && !comment.trim()) {
      setCommentError("Enter a comment to reject: say what the maker should change.");
      requestAnimationFrame(() => document.getElementById(id)?.focus());
      return;
    }
    setCommentError(null);
    setBusy(act);
    try {
      await onDecide(act, comment.trim());
      setComment("");
      requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="Your decision" bodyClassName="grid gap-4">
      <div className="max-w-xl">
        <Field id={id} label="Comment" note="Required to reject. The maker sees it with the version." error={commentError}>
          <Textarea id={id} value={comment} limit={REVIEW_COMMENT_MAX} countValue={comment.trim()} rows={4} placeholder="What you checked"
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => { setComment(e.target.value); if (commentError && e.target.value.trim()) setCommentError(null); }} />
        </Field>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <BlockedButton reason={approveWhy} disabled={busy !== null} aria-busy={busy === "approve" || undefined} onClick={() => void decide("approve")}>
          {busy === "approve" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Approve version {version}
        </BlockedButton>
        <BlockedButton variant="secondary" reason={rejectWhy} disabled={busy !== null} aria-busy={busy === "reject" || undefined} onClick={() => void decide("reject")}>
          {busy === "reject" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Reject
        </BlockedButton>
        <p className="max-w-[72ch] text-caption text-fg-3">{effect}</p>
      </div>
      {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
    </Panel>
  );
}
