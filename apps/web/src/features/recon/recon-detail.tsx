"use client";

import { mayDo } from "@starterkit/shared/spaces";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { EditIcon } from "@starterkit/ui/ui/icons";
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
import { ReconOverview } from "./recon-overview";
import { RECON_SHAPE } from "./shapes";
import { useDraftEndings } from "./draft-actions";

// The Posting groups tab loads when opened (its table and dialog stay out of the page's first load: the route sat at
// the 300 kB guard once the sidebar's live counts landed, 24 Nov); its own loading shape shows meanwhile.
const PostingGroups = dynamic(() => import("./posting-groups").then((m) => m.PostingGroups), { ssr: false, loading: () => <LoadingShape sections={GROUPS_TAB_SHAPE} shown /> });
const GROUPS_TAB_SHAPE = [{ kind: "table", chrome: 144, rows: 5, rowHeight: 56 }] as const;
// Configuration and History load when opened too, like Posting groups (the route sat at the 300 kB guard, 24 Nov)
const TAB_SHAPE = [{ kind: "panels", panels: [[12, 240]] }] as const;
const tabLoading = () => <LoadingShape sections={TAB_SHAPE} shown />;
const SpecView = dynamic(() => import("./spec-view").then((m) => m.SpecView), { ssr: false, loading: tabLoading });
const ResultColumnsPanel = dynamic(() => import("./result-columns-panel").then((m) => m.ResultColumnsPanel), { ssr: false });
const VersionsTable = dynamic(() => import("./recon-tables").then((m) => m.VersionsTable), { ssr: false, loading: () => <LoadingShape sections={GROUPS_TAB_SHAPE} shown /> });
const ActivityTable = dynamic(() => import("./recon-tables").then((m) => m.ActivityTable), { ssr: false });
import { MAKER_REASON, reconEditHref, reconHref, reconsHref, reconVersionHref, useRecon, useReconVersion, useSpaceRoles, useStartVersion } from "./use-recons";

const TAB_LABEL: Record<ReconTab, string> = { overview: "Overview", configuration: "Configuration", posting: "Posting groups", reports: "Reports", history: "History" };

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

/** "Edit recon": a new draft's setup; a version in review opens on its page (an open draft: the header's Continue editing). */
function editAction(r: ReconDto, spaceId: string, maker: boolean, start: { busy: boolean; run: () => void }): HeaderAction | null {
  if (r.draft?.status === "in_review") return { label: `Open version ${r.draft.version}`, href: reconVersionHref(spaceId, r.id, r.draft.id) };
  if (r.draft) return null; // the header's Continue editing
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

  const maker = mayDo(roles, "editRecon");
  // who may start a run of the published version (POST …/runs)
  const runner = mayDo(roles, "runRecon");
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
        actions={maker && r.draft?.status === "draft" ? <Button asChild variant="edit"><Link href={reconEditHref(spaceId, id, 6)}><Icon icon={EditIcon} />Continue editing</Link></Button> : undefined}
        more={more.length ? more : undefined} />
      <RouteTabs aria-label="Recon sections">
        {RECON_TABS.map((t) => <Link key={t} href={tabHref(t)} aria-current={tab === t ? "page" : undefined}>{TAB_LABEL[t]}</Link>)}
      </RouteTabs>
      {tab === "overview" ? <ReconOverview spaceId={spaceId} id={id} r={r} runner={runner} configHref={tabHref("configuration")} />
        : tab === "posting" ? <PostingGroups spaceId={spaceId} id={id} />
        : tab === "reports" ? (
          // the report generator's (DEC-060): this recon's templates and files live in Reports; the tab leads there
          <Panel title="Reports" description="Report files of this recon, made after its runs or on request, and the templates they are made from.">
            <ul className="grid gap-2 text-body-sm">
              <li><Link className="text-primary hover:underline" href={`/spaces/${encodeURIComponent(spaceId)}/reports?recon=${encodeURIComponent(id)}`}>See this recon&apos;s report files</Link></li>
              <li><Link className="text-primary hover:underline" href={`/spaces/${encodeURIComponent(spaceId)}/reports/templates?recon=${encodeURIComponent(id)}`}>See its report templates</Link></li>
              <li><Link className="text-primary hover:underline" href={`/spaces/${encodeURIComponent(spaceId)}/reports/templates/new?recon=${encodeURIComponent(id)}`}>New report template</Link></li>
            </ul>
          </Panel>
        )
        : tab === "history" ? (
          // versions and activity in one place (owner, 22 Nov: few tabs); the header's date range filters the activity
          <><VersionsTable spaceId={spaceId} id={id} /><ActivityTable spaceId={spaceId} id={id} /></>
        ) : (
          <>
            {q.error && <Notice tone="warn" live>Couldn&apos;t refresh this recon; showing the last loaded draft.</Notice>}
            {r.draft?.status === "draft" && r.draft.reviewComment && <Notice tone="warn">Sent back: {r.draft.reviewComment}</Notice>}
            {r.draft?.status === "in_review" && <Notice>Version {r.draft.version} is waiting for a config checker; it can&apos;t be edited meanwhile.</Notice>}
            {shown && <SpecView spaceId={spaceId} spec={shown.spec} />}
            {r.published && <ResultColumnsPanel spaceId={spaceId} configId={id} spec={r.published.spec} canEdit={mayDo(roles, "resultColumns")} />}
          </>
        )}
    </div>
  );
}
