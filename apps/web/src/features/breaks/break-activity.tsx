"use client";

import { useMemo } from "react";
import { Avatar, ColumnsMenu, DataTable, Notice, Panel, RelativeTime, Toolbar, Truncate } from "@starterkit/ui/ds";
import { ActivityIcon } from "@starterkit/ui/ui/icons";
import { actionLabel } from "@starterkit/shared/audit";
import type { ActivityDto } from "@starterkit/shared/contracts/audit";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { breakActivity, type TrailFilters } from "@/lib/shared/queries";

const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
/** What an entry did, in words: its action, then the note or resolution it carries. */
function whatText(e: ActivityDto): string {
  const note = field(e.after, "note"), resolution = field(e.after, "resolution");
  return [actionLabel(e.action), typeof resolution === "string" ? resolution.toLowerCase().replaceAll("_", " ") : null, typeof note === "string" ? `“${note}”` : null].filter(Boolean).join(" · ");
}

/** A break's own trail (GET …/breaks/{id}/activity), newest first: time, who, what. */
export function BreakActivity({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => breakActivity(spaceId, id), [spaceId, id]);
  const t = useTableQuery<ActivityDto, TrailFilters>(def);
  const columns = useMemo(() => [
    { key: "at", header: "Time", mobile: "meta" as const, className: "whitespace-nowrap", cell: (e: ActivityDto) => <RelativeTime at={Date.parse(e.at)} /> },
    { key: "actor", header: "User", mobile: "meta" as const, className: "min-w-48", cell: (e: ActivityDto) => (
      <span className="flex min-w-0 max-w-56 items-center gap-2.5"><Avatar name={e.actor.name} seed={e.actor.id} /><Truncate title={e.actor.name}>{e.actor.name}</Truncate></span>
    ) },
    { key: "event", header: "What happened", mobile: "title" as const, className: "whitespace-normal wrap-anywhere md:min-w-80 w-full", cell: (e: ActivityDto) => <span className="text-fg">{whatText(e)}</span> },
  ], []);
  return (
    <>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh this list; showing the rows loaded before. {errorText(t.staleError)}</Notice>}
      <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={ActivityIcon} title="Activity" description="Newest first" count={t.count}>
        <DataTable label="Activity" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(e) => e.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load activity", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={{ icon: ActivityIcon, title: "No activity yet", description: "Entries appear here when someone takes, assigns or resolves this break." }} />
      </Panel>
    </>
  );
}
