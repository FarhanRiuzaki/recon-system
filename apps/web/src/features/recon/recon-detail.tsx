"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@starterkit/ui/ui/button";
import { Failure, Notice, Panel, RouteTabs, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { ReconDto } from "@starterkit/shared/contracts/recon";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { type HeaderAction, PageHeader } from "@/components/shell/page-header";
import { useAuth } from "@/lib/client/auth-context";
import { api, isNotFound } from "@/lib/client/api";
import { RECON_KEY } from "@/lib/shared/queries";
import { reconStatus } from "@/lib/shared/recon-status";
import { Builder, type SaveState } from "./builder";
import { discardConfirm } from "./discard-dialog";
import { RECON_TABS, type ReconTab, at } from "./recon-text";
import { ActivityTable, VersionsTable } from "./recon-tables";
import { RunControl } from "./run-control";
import { RunSummary } from "./run-summary";
import { RECON_SHAPE } from "./shapes";
import { SpecView } from "./spec-view";
import { MAKER_REASON, reconApi, reconHref, reconsHref, reconRunHref, reconVersionHref, useLastRun, useRecon, useReconVersion, useSpaceRoles, useStartVersion } from "./use-recons";

const TAB_LABEL: Record<ReconTab, string> = { overview: "Overview", versions: "Versions", activity: "Activity" };

/** A recon nobody submitted (DELETE …/recons/{id} takes it), for a config maker or a space admin (README row Plan 3). */
export const discardable = (r: ReconDto, roles: readonly string[]) =>
  (roles.includes("config_maker") || roles.includes("space_admin")) && r.publishedVersion === null && !!r.draft && !r.draft.submitterId && !r.draft.reviewComment;

/**
 * The line under the title: the open draft (by whom, when someone else made it) and what is live meanwhile
 * (BUILDER-SPEC "PageHeader"); the draft's autosave lives here only (ui-standard §1a): saved at, Saving…, Not saved.
 */
function lineOf(r: ReconDto, by: string | null, save: SaveState["status"] = "saved"): string {
  const live = r.published ? `live v${r.published.version}${r.published.publishedAt ? ` since ${at(r.published.publishedAt)}` : ""}` : "no live version";
  if (!r.draft) return r.published ? `Version ${r.published.version} · ${live}` : live;
  // "incomplete": a field is still being filled in; the field says what (nothing is sent until it is)
  const saved = save === "saving" ? "Saving…" : save === "failed" || save === "incomplete" ? "Not saved" : `saved ${at(r.draft.updatedAt)}`;
  const what = r.draft.status === "in_review" ? `Version ${r.draft.version} in review` : `Draft v${r.draft.version} · ${saved}`;
  if (by) return `${what} · by ${by} · ${live}`;
  return `${what} · ${live}`;
}

/** "Edit recon": the open draft is this page; a version in review opens on its page; else a new draft from the published one. */
function editAction(r: ReconDto, spaceId: string, maker: boolean, start: { busy: boolean; run: () => void }): HeaderAction | null {
  if (r.draft?.status === "in_review") return { label: `Open version ${r.draft.version}`, href: reconVersionHref(spaceId, r.id, r.draft.id) };
  if (r.draft) return null;
  return maker ? { label: "Edit recon", onSelect: start.run, busy: start.busy } : { label: "Edit recon", reason: MAKER_REASON };
}

/**
 * A recon (/spaces/[spaceId]/recons/[configId]): Overview = the builder over the open draft (editable for a config
 * maker); with no draft open, the version in review or the published one as read-only cards (ui-standard §1a
 * "Detail", the version page's SpecView) and the last run. Versions and Activity are its lists.
 */
export function ReconDetail({ spaceId, id, tab }: { spaceId: string; id: string; tab: ReconTab }) {
  const q = useRecon(spaceId, id);
  const roles = useSpaceRoles(spaceId);
  const start = useStartVersion(spaceId, id);
  const [save, setSave] = useState<SaveState | null>(null);
  const router = useRouter();
  const qc = useQueryClient();
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const { user } = useAuth();
  const draftId = q.data?.draft?.id ?? "";
  const dq = useReconVersion(spaceId, id, draftId, !!draftId);
  const building = q.data?.draft?.status === "draft";
  const last = useLastRun(spaceId, id, tab === "overview" && !building && !!q.data?.published);

  if (isNotFound(q.error)) return <DetailNotFound title="Recon" noun="recon" list={{ href: reconsHref(spaceId), label: "Recons" }} />;
  if (q.error && !q.data) return <div className="grid gap-section"><PageHeader title="Recon" /><Panel><Failure title="The draft couldn't be loaded." error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  const r = q.data;
  if (!r || skeleton) return <LoadingShape sections={RECON_SHAPE} shown={skeleton} />;

  const maker = roles.includes("config_maker");
  // who may start a run of the published version (POST …/runs)
  const runner = roles.some((x) => x === "config_maker" || x === "space_admin" || x === "operator");
  const st = reconStatus(r);
  const edit = editAction(r, spaceId, maker, { busy: start.isPending, run: () => start.mutate() });
  // Delete draft recon: an item of the header's ⋯ menu with its confirmation (ui-standard §1a)
  const more: HeaderAction[] = [
    ...(edit ? [edit] : []),
    ...(discardable(r, roles) ? [{ label: "Delete draft recon", destructive: true as const, confirm: discardConfirm(r.name, async () => {
      await api(reconApi(spaceId, id), { method: "DELETE" });
      toast(`Deleted the draft recon ${r.name}.`);
      await qc.invalidateQueries({ queryKey: RECON_KEY });
      router.push(reconsHref(spaceId));
    }) }] : []),
  ];
  const makerId = r.draft?.makerId ?? null;
  const by = makerId && makerId !== user.id ? (dq.data?.people.find((p) => p.id === makerId)?.name ?? null) : null;
  const tabHref = (t: ReconTab) => (t === "overview" ? reconHref(spaceId, id) : `${reconHref(spaceId, id)}?tab=${t}`);
  const shown = r.draft ?? r.published;
  const editable = maker && r.draft?.status === "draft";

  return (
    <div className="grid gap-section">
      <PageHeader title={r.name} status={<StatusChip health={st.health} label={st.label} description={st.description} />} description={lineOf(r, by, editable ? save?.status : undefined)}
        actions={editable && save?.status === "failed" ? <Button type="button" variant="secondary" onClick={save.retry}>Retry</Button> : undefined} more={more.length ? more : undefined} />
      <RouteTabs aria-label="Recon sections">
        {RECON_TABS.map((t) => <Link key={t} href={tabHref(t)} aria-current={tab === t ? "page" : undefined}>{TAB_LABEL[t]}</Link>)}
      </RouteTabs>
      {tab === "versions" ? <VersionsTable spaceId={spaceId} id={id} />
        : tab === "activity" ? <ActivityTable spaceId={spaceId} id={id} /> : (
          <>
            {q.error && <Notice tone="warn" live>Couldn&apos;t refresh this recon; showing the last loaded draft.</Notice>}
            {r.draft?.status === "draft" && r.draft.reviewComment && <Notice tone="warn">Sent back: {r.draft.reviewComment}</Notice>}
            {r.draft?.status === "in_review" && <Notice>Version {r.draft.version} is waiting for a config checker; it can&apos;t be edited meanwhile.</Notice>}
            {building && shown && <Builder key={shown.id} spaceId={spaceId} recon={r} version={shown} editable={editable} canEdit={maker} onSaveState={setSave} />}
            {!building && r.published && runner && <RunControl spaceId={spaceId} id={id} spec={r.published.spec} />}
            {!building && last && r.published && <RunSummary run={last} spec={r.published.spec}
              labels={[r.published.spec.sides[0].label, r.published.spec.sides[1].label]} action={<Button asChild variant="secondary"><Link href={reconRunHref(spaceId, id, last.id)}>Open run</Link></Button>} />}
            {!building && shown && <SpecView spaceId={spaceId} spec={shown.spec} />}
          </>
        )}
    </div>
  );
}
