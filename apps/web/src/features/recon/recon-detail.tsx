"use client";

import Link from "next/link";
import { Button } from "@starterkit/ui/ui/button";
import { Failure, Notice, Panel, RouteTabs, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { BRAND } from "@starterkit/shared/brand";
import type { ReconDto } from "@starterkit/shared/contracts/recon";
import { DetailNotFound } from "@/components/detail-not-found";
import { LoadingShape } from "@/components/route-skeleton";
import { type HeaderAction, PageHeader } from "@/components/shell/page-header";
import { useAuth } from "@/lib/client/auth-context";
import { isNotFound } from "@/lib/client/api";
import { reconStatus } from "@/lib/shared/recon-status";
import { RECON_TABS, type ReconTab, at } from "./recon-text";
import { ActivityTable, VersionsTable } from "./recon-tables";
import { ReconOverview } from "./recon-overview";
import { RECON_SHAPE } from "./shapes";
import { SpecView } from "./spec-view";
import { useDraftEndings } from "./draft-actions";
import { MAKER_REASON, reconEditHref, reconHref, reconsHref, reconVersionHref, useRecon, useReconVersion, useSpaceRoles, useStartVersion } from "./use-recons";

const TAB_LABEL: Record<ReconTab, string> = { overview: "Overview", configuration: "Configuration", history: "History" };

export { discardable } from "./draft-actions";

/**
 * The line under the title: the open draft (by whom, when someone else made it) and what is live meanwhile
 * (BUILDER-SPEC "PageHeader"); the draft's autosave lives here only (ui-standard §1a): saved at, Saving…, Not saved.
 */
function lineOf(r: ReconDto, by: string | null): string {
  const live = r.published ? `live v${r.published.version}${r.published.publishedAt ? ` since ${at(r.published.publishedAt)}` : ""}` : "no live version";
  if (!r.draft) return r.published ? `Version ${r.published.version} · ${live}` : live;
  const saved = `saved ${at(r.draft.updatedAt)}`;
  const what = r.draft.status === "in_review" ? `Version ${r.draft.version} in review` : `Draft v${r.draft.version} · ${saved}`;
  if (by) return `${what} · by ${by} · ${live}`;
  return `${what} · ${live}`;
}

/** "Edit recon": a new draft's setup; an open draft's setup ("Continue editing"); a version in review opens on its page. */
function editAction(r: ReconDto, spaceId: string, maker: boolean, start: { busy: boolean; run: () => void }): HeaderAction | null {
  if (r.draft?.status === "in_review") return { label: `Open version ${r.draft.version}`, href: reconVersionHref(spaceId, r.id, r.draft.id) };
  if (r.draft) return maker ? { label: "Continue editing", href: reconEditHref(spaceId, r.id, 5) } : null;
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
  const endings = useDraftEndings(spaceId, q.data, roles);
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const { user } = useAuth();
  const draftId = q.data?.draft?.id ?? "";
  const dq = useReconVersion(spaceId, id, draftId, !!draftId);

  if (isNotFound(q.error)) return <DetailNotFound title="Recon" noun="recon" list={{ href: reconsHref(spaceId), label: "Recons" }} />;
  if (q.error && !q.data) return <div className="grid gap-section"><PageHeader title="Recon" /><Panel><Failure title="The draft couldn't be loaded." error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  const r = q.data;
  if (!r || skeleton) return <LoadingShape sections={RECON_SHAPE} shown={skeleton} />;

  const maker = roles.includes("config_maker");
  // who may start a run of the published version (POST …/runs)
  const runner = roles.some((x) => x === "config_maker" || x === "space_admin" || x === "operator");
  const st = reconStatus(r);
  const edit = editAction(r, spaceId, maker, { busy: start.isPending, run: () => start.mutate() });
  const more: HeaderAction[] = [...(edit ? [edit] : []), ...endings];
  const makerId = r.draft?.makerId ?? null;
  const by = makerId && makerId !== user.id ? (dq.data?.people.find((p) => p.id === makerId)?.name ?? null) : null;
  const tabHref = (t: ReconTab) => (t === "overview" ? reconHref(spaceId, id) : `${reconHref(spaceId, id)}?tab=${t}`);
  // the Configuration shows what runs (or, before the first approval, the draft); an open draft is continued in its setup
  const shown = r.published ?? r.draft;

  return (
    <div className="grid gap-section">
      <PageHeader title={r.name} status={<StatusChip health={st.health} label={st.label} description={st.description} />} description={lineOf(r, by)}
        actions={edit && "href" in edit && edit.href && r.draft?.status === "draft" ? <Button asChild><Link href={edit.href}>Continue editing</Link></Button> : undefined}
        more={more.length ? more : undefined} />
      <RouteTabs aria-label="Recon sections">
        {RECON_TABS.map((t) => <Link key={t} href={tabHref(t)} aria-current={tab === t ? "page" : undefined}>{TAB_LABEL[t]}</Link>)}
      </RouteTabs>
      {tab === "overview" ? <ReconOverview spaceId={spaceId} id={id} r={r} runner={runner} configHref={tabHref("configuration")} />
        : tab === "history" ? (
          // versions and activity in one place (owner, 22 Nov: few tabs); the header's date range filters the activity
          <><VersionsTable spaceId={spaceId} id={id} /><ActivityTable spaceId={spaceId} id={id} /></>
        ) : (
          <>
            {q.error && <Notice tone="warn" live>Couldn&apos;t refresh this recon; showing the last loaded draft.</Notice>}
            {r.draft?.status === "draft" && r.draft.reviewComment && <Notice tone="warn">Sent back: {r.draft.reviewComment}</Notice>}
            {r.draft?.status === "in_review" && <Notice>Version {r.draft.version} is waiting for a config checker; it can&apos;t be edited meanwhile.</Notice>}
            {r.draft?.status === "draft" && (
              // an open draft: where it stands and the way back into its setup
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-tray px-4 py-3">
                <p className="min-w-0 flex-1 basis-64 text-body-sm text-fg">
                  Draft v{r.draft.version} is open{r.published ? `; version ${r.published.version} keeps running until it is approved` : ""}.
                </p>
                {maker && <Button asChild variant="secondary" size="sm"><Link href={reconEditHref(spaceId, r.id, 5)}>Continue editing</Link></Button>}
              </div>
            )}
            {shown && <SpecView spaceId={spaceId} spec={shown.spec} />}
          </>
        )}
    </div>
  );
}
