"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { BlockedButton, Failure, Notice, Panel, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { ReconVersionDetailDto } from "@starterkit/shared/contracts/recon";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { VersionDecision, VersionLayout } from "@/components/version-layout";
import { useAuth } from "@/lib/client/auth-context";
import { api, isNotFound } from "@/lib/client/api";
import { APPROVALS_KEY, RECON_KEY } from "@/lib/shared/queries";
import { reconVersionChip } from "@/lib/shared/recon-status";
import { at, reviewReason } from "./recon-text";
import { RECON_VERSION_SHAPE } from "./shapes";
import { SpecView } from "./spec-view";
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
 * A recon version (ui-standard §1a "Version", VersionLayout): the decision first under the header while it is in
 * review, then its settings, sides and passes as text (SpecView: no inspector, no disabled inputs); with Approve and Reject as BlockedButtons saying who may act (maker ≠ checker); a sent-back draft
 * shows the comment and "Edit version n". The API's 409 self_approval / invalid_state shows beside the buttons.
 */
export function ReconVersionReview({ spaceId, id, versionId }: { spaceId: string; id: string; versionId: string }) {
  const rq = useRecon(spaceId, id);
  const vq = useReconVersion(spaceId, id, versionId);
  const roles = useSpaceRoles(spaceId);
  const { user } = useAuth();
  const qc = useQueryClient();
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

  async function decide(act: "approve" | "reject", comment: string) {
    await api(reconApi(spaceId, id, `/versions/${encodeURIComponent(versionId)}/${act}`), { method: "POST", body: JSON.stringify(act === "reject" ? { comment } : {}) });
    toast(act === "approve" ? `Version ${v!.version} of ${r!.name} approved. It runs from its next schedule.` : `Version ${v!.version} of ${r!.name} sent back to its maker with your comment.`);
    await Promise.all([qc.invalidateQueries({ queryKey: RECON_KEY }), qc.invalidateQueries({ queryKey: APPROVALS_KEY })]);
  }

  return (
    <VersionLayout
      header={<PageHeader title={`${r.name} · version ${v.version}`} crumb={`Version ${v.version}`} status={<StatusChip health={st.health} label={st.label} description={st.description} />}
        description={lineOf(v, published)} trail={[{ label: r.name, href: reconHref(spaceId, id) }]} actions={edit || undefined} />}
      notice={v.status === "draft" && v.reviewComment && <Notice tone="warn">Sent back by {nameOf(v, v.checkerId) ?? "a config checker"}: {v.reviewComment}</Notice>}
      decision={v.status === "in_review" && (
        <VersionDecision id="rv-comment" version={v.version} mine={[v.submitterId, v.makerId, ...v.contributorIds].includes(user.id)}
          approveWhy={approveWhy} rejectWhy={rejectWhy} onDecide={decide}
          effect={`Approving publishes version ${v.version}${published ? ` and retires version ${published}` : ""}. Runs use it from the next schedule.`} />
      )}
      settings={<SpecView spaceId={spaceId} spec={v.spec} />} />
  );
}
