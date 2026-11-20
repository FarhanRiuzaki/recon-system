"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { type ChangeEvent, useState } from "react";
import { BlockedButton, Failure, Field, Notice, Panel, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { ReconVersionDetailDto } from "@starterkit/shared/contracts/recon";
import { REVIEW_COMMENT_MAX } from "@starterkit/shared/sources";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { useAuth } from "@/lib/client/auth-context";
import { api, errorText, isNotFound } from "@/lib/client/api";
import { RECON_KEY } from "@/lib/shared/queries";
import { reconVersionChip } from "@/lib/shared/recon-status";
import { Builder } from "./builder";
import { at, reviewReason } from "./recon-text";
import { RECON_VERSION_SHAPE } from "./shapes";
import { MAKER_REASON, reconApi, reconHref, reconsHref, useRecon, useReconVersion, useSpaceRoles } from "./use-recons";

const nameOf = (v: ReconVersionDetailDto, id: string | null) => (id ? (v.people.find((p) => p.id === id)?.name ?? "a removed user") : null);

/** One sentence under the title: who did what, and what applies meanwhile. */
function lineOf(v: ReconVersionDetailDto, published: number | null): string {
  if (v.status === "in_review") {
    const by = nameOf(v, v.submitterId);
    const when = v.submittedAt ? at(v.submittedAt) : null;
    return [by ? `Sent by ${by}${when ? `, ${when}` : ""}` : `Sent${when ? ` ${when}` : ""}`, "waiting for a config checker",
      published ? `version ${published} stays live until this is approved` : "nothing runs until this is approved"].join(" · ");
  }
  if (v.status === "draft" && v.reviewComment) return ["Draft", `sent back by ${nameOf(v, v.checkerId) ?? "a config checker"}`, ...(published ? [`version ${published} stays live`] : [])].join(" · ");
  if (v.status === "published") return `Published${v.publishedAt ? ` ${at(v.publishedAt)}` : ""}${v.checkerId ? ` · approved by ${nameOf(v, v.checkerId)}` : ""} · live`;
  if (v.status === "retired") return `Retired · replaced by a newer published version${v.checkerId ? ` · approved by ${nameOf(v, v.checkerId)}` : ""}`;
  return `Draft · last saved by ${nameOf(v, v.makerId) ?? "nobody yet"}, ${at(v.updatedAt)}`;
}

/**
 * A recon version (Plan 2 Task 7 pattern): its sides, passes and settings read only; the decision panel only while it
 * is in review, with Approve and Reject as BlockedButtons saying who may act (maker ≠ checker); a sent-back draft
 * shows the comment and "Edit version n". The API's 409 self_approval / invalid_state shows beside the buttons.
 */
export function ReconVersionReview({ spaceId, id, versionId }: { spaceId: string; id: string; versionId: string }) {
  const rq = useRecon(spaceId, id);
  const vq = useReconVersion(spaceId, id, versionId);
  const roles = useSpaceRoles(spaceId);
  const { user } = useAuth();
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const skeleton = useDelayedFlag((!rq.data || !vq.data) && !rq.error && !vq.error);

  const list = { href: reconsHref(spaceId), label: "Recons" };
  if (isNotFound(rq.error) || isNotFound(vq.error)) return <DetailNotFound title="Recon version" noun="version" list={list} />;
  if ((rq.error && !rq.data) || (vq.error && !vq.data)) {
    return <div className="grid gap-section"><PageHeader title="Recon version" />
      <Panel><Failure title="Couldn't load this version" error={rq.error ?? vq.error} source={BRAND.name} onRetry={() => { void rq.refetch(); void vq.refetch(); }} /></Panel></div>;
  }
  const r = rq.data, v = vq.data;
  if (!r || !v || skeleton) return <LoadingShape sections={RECON_VERSION_SHAPE} shown={skeleton} />;

  const checker = roles.includes("config_checker");
  const maker = roles.includes("config_maker");
  const approveWhy = reviewReason(v, user.id, checker, "approve");
  const rejectWhy = reviewReason(v, user.id, checker, "reject");
  const published = r.published && r.published.id !== v.id && v.status !== "retired" ? r.published.version : null;
  const st = reconVersionChip(v);
  const edit = v.status === "draft" && r.draft?.id === v.id && (maker
    ? <Button asChild><Link href={reconHref(spaceId, id)}>Edit version {v.version}</Link></Button>
    : <BlockedButton reason={MAKER_REASON}>Edit version {v.version}</BlockedButton>);

  async function decide(act: "approve" | "reject") {
    setError(null);
    if (act === "reject" && !comment.trim()) {
      setCommentError("Enter a comment to reject: say what the maker should change.");
      requestAnimationFrame(() => document.getElementById("rv-comment")?.focus());
      return;
    }
    setCommentError(null);
    setBusy(act);
    try {
      await api(reconApi(spaceId, id, `/versions/${encodeURIComponent(versionId)}/${act}`), { method: "POST", body: JSON.stringify(act === "reject" ? { comment: comment.trim() } : {}) });
      toast(act === "approve" ? `Version ${v!.version} of ${r!.name} approved. It runs from its next schedule.` : `Version ${v!.version} of ${r!.name} sent back to its maker with your comment.`);
      setComment("");
      await qc.invalidateQueries({ queryKey: RECON_KEY });
      requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-section">
      <PageHeader title={`${r.name} · version ${v.version}`} status={<StatusChip health={st.health} label={st.label} description={st.description} />}
        description={lineOf(v, published)} trail={[{ label: r.name, href: reconHref(spaceId, id) }]} actions={edit || undefined} />
      {v.status === "draft" && v.reviewComment && <Notice tone="warn">Sent back by {nameOf(v, v.checkerId) ?? "a config checker"}: {v.reviewComment}</Notice>}

      <Builder key={v.id} spaceId={spaceId} recon={r} version={v} editable={false} canEdit={false} bar={false} />

      {v.status === "in_review" && approveWhy && (
        <Panel title="Your decision" bodyClassName="grid gap-3">
          <p className="text-body-sm text-fg-2">{[v.submitterId, v.makerId, ...v.contributorIds].includes(user.id) ? "A config checker other than you approves or rejects this version." : "A config checker of this space approves or rejects this version."}</p>
          <span><BlockedButton reason={approveWhy}>Approve version {v.version}</BlockedButton></span>
        </Panel>
      )}
      {v.status === "in_review" && !approveWhy && (
        <Panel title="Your decision" bodyClassName="grid gap-4">
          <div className="max-w-xl">
            <Field id="rv-comment" label="Comment" note="Required to reject. The maker sees it with the version." error={commentError}>
              <Textarea id="rv-comment" value={comment} limit={REVIEW_COMMENT_MAX} countValue={comment.trim()} rows={4} placeholder="What you checked"
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => { setComment(e.target.value); if (commentError && e.target.value.trim()) setCommentError(null); }} />
            </Field>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <BlockedButton reason={approveWhy} disabled={busy !== null} aria-busy={busy === "approve" || undefined} onClick={() => void decide("approve")}>
              {busy === "approve" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Approve version {v.version}
            </BlockedButton>
            <BlockedButton variant="secondary" reason={rejectWhy} disabled={busy !== null} aria-busy={busy === "reject" || undefined} onClick={() => void decide("reject")}>
              {busy === "reject" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Reject
            </BlockedButton>
            <p className="max-w-[72ch] text-caption text-fg-3">
              Approving publishes version {v.version}{published ? ` and retires version ${published}` : ""}. Runs use it from the next schedule.
            </p>
          </div>
          {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
        </Panel>
      )}
    </div>
  );
}
