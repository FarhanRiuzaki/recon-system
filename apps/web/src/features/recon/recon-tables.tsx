"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Avatar, ColumnsMenu, DataTable, Notice, Panel, RelativeTime, StatusChip, Toolbar, Truncate } from "@starterkit/ui/ds";
import { ActivityIcon, BranchIcon } from "@starterkit/ui/ui/icons";
import type { ActivityDto } from "@starterkit/shared/contracts/audit";
import type { ReconVersionRowDto } from "@starterkit/shared/contracts/recon";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import type { NoFilters, TrailFilters } from "@/lib/shared/queries";
import { reconActivity, reconVersions } from "@/lib/shared/queries";
import { RECON_VERSION_LEGEND, reconVersionChip } from "@/lib/shared/recon-status";
import { activitySentence, at } from "./recon-text";
import { reconVersionHref } from "./use-recons";

// A recon's Versions and Activity tabs: server-paged, newest first, page and size in the URL; each a list in its own
// right, with saved views and the column chooser.

const none = <span className="text-fg-3">—</span>;
const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const who = (p: ReconVersionRowDto["maker"]) => (p ? (p.name ?? "A removed user") : null);

/** A recon's versions, newest first, sortable by version or last change; each opens its version page. */
export function VersionsTable({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => reconVersions(spaceId, id), [spaceId, id]);
  const t = useTableQuery<ReconVersionRowDto, NoFilters>(def);
  const columns = useMemo(() => [
    { key: "version", header: "Version", sortable: true, mobile: "title" as const, cell: (v: ReconVersionRowDto) => <Link href={reconVersionHref(spaceId, id, v.id)} className={LINK}>Version {v.version}</Link> },
    { key: "status", header: "State", mobile: "meta" as const, cell: (v: ReconVersionRowDto) => {
      const c = reconVersionChip(v);
      const back = c.label === "Sent back" && v.checker ? `Sent back by ${who(v.checker)}` : null;
      return <span className="grid justify-items-start gap-1"><StatusChip health={c.health} label={c.label} />{back && <span className="text-caption text-fg-3">{back}</span>}</span>;
    } },
    { key: "maker", header: "Last edited by", mobile: "meta" as const, cell: (v: ReconVersionRowDto) => who(v.maker) ?? none },
    { key: "submitter", header: "Sent by", mobile: "meta" as const, cell: (v: ReconVersionRowDto) => (v.submitter ? `${who(v.submitter)}${v.submittedAt ? ` · ${at(v.submittedAt)}` : ""}` : none) },
    { key: "checker", header: "Approved by", mobile: "meta" as const, cell: (v: ReconVersionRowDto) => (v.checker && v.publishedAt ? `${who(v.checker)} · ${at(v.publishedAt)}` : none) },
    { key: "updatedAt", header: "Changed", sortable: true, mobile: "meta" as const, cell: (v: ReconVersionRowDto) => at(v.updatedAt) },
  ], [spaceId, id]);
  return (
    <>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh this list; showing the rows loaded before. {errorText(t.staleError)}</Notice>}
      <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={BranchIcon} title="Versions" description="A new version runs once a config checker approves it" count={t.count} legend={RECON_VERSION_LEGEND}>
        <DataTable label="Versions" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(v) => v.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load versions", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={{ icon: BranchIcon, title: "No versions yet", description: "A version appears here once a config maker starts one." }} />
      </Panel>
    </>
  );
}

/** The sentence without its actor in front (the User column names them): "Sent version 1 for approval." */
function withoutActor(e: ActivityDto): string {
  const s = activitySentence(e), name = `${e.actor.name} `;
  return s.startsWith(name) ? s.charAt(name.length).toUpperCase() + s.slice(name.length + 1) : s;
}

/** The recon's own activity: one sentence per event, newest first. */
export function ActivityTable({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => reconActivity(spaceId, id), [spaceId, id]);
  const t = useTableQuery<ActivityDto, TrailFilters>(def);
  // as a source's Activity and the activity log read (owner, 22 Nov: one pattern in every module): time, user, what
  const columns = useMemo(() => [
    { key: "at", header: "Time", mobile: "meta" as const, className: "whitespace-nowrap", cell: (e: ActivityDto) => (
      <span className="grid"><RelativeTime at={Date.parse(e.at)} touchDate={false} /><span className="font-mono text-caption text-fg-3">{at(e.at)}</span></span>
    ) },
    { key: "actor", header: "User", mobile: "meta" as const, className: "min-w-48", cell: (e: ActivityDto) => (
      <span className="flex min-w-0 max-w-56 items-center gap-2.5"><Avatar name={e.actor.name} seed={e.actor.id} /><Truncate title={e.actor.name}>{e.actor.name}</Truncate></span>
    ) },
    { key: "event", header: "What happened", mobile: "title" as const, className: "whitespace-normal wrap-anywhere md:min-w-80 w-full", cell: (e: ActivityDto) => <span className="text-fg">{withoutActor(e)}</span> },
  ], []);
  return (
    <>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh this list; showing the rows loaded before. {errorText(t.staleError)}</Notice>}
      <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={ActivityIcon} title="Activity" description="Newest first" count={t.count}>
        <DataTable label="Activity" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(e) => e.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load activity", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={{ icon: ActivityIcon, title: "No activity yet", description: "Entries appear here when someone changes this recon or one of its versions." }} />
      </Panel>
    </>
  );
}
