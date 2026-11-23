"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { type Column, ColumnsMenu, DataTable, Notice, Panel, StatusChip, Toolbar } from "@starterkit/ui/ds";
import { formatDate, formatNumber } from "@starterkit/ui/lib/format";
import { LogIcon } from "@starterkit/ui/ui/icons";
import type { PostingGroupRowDto } from "@starterkit/shared/contracts/integrations";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { amountText } from "@/lib/shared/amount";
import { groupChip, groupKeyText, sendsAtText } from "@/lib/shared/posting";
import { POSTING_GROUPS } from "@/lib/shared/queries";

const GroupDialog = dynamic(() => import("./posting-group-dialog"), { ssr: false });
const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
export const periodText = (g: { period: string; part: number }) => `${formatDate(Date.parse(`${g.period}T00:00:00+07:00`))}${g.part > 1 ? ` · part ${g.part}` : ""}`;

/**
 * A recon's posting groups (stage 5, design §4.8): the breaks a grouped posting variant sends as one call, per period
 * (approval date), key and currency, newest first; a row opens the group with its breaks (?group=). Read only: a group
 * is sent at its time, never by hand.
 */
export function PostingGroups({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => POSTING_GROUPS(spaceId, id), [spaceId, id]);
  const t = useTableQuery<PostingGroupRowDto, { status: string }>(def);
  const sp = useSearchParams(), router = useRouter(), path = usePathname();
  const open = sp.get("group");
  const withGroup = (g: string | null) => { const p = new URLSearchParams(sp); if (g) p.set("group", g); else p.delete("group"); return `${path}?${p}`; };
  const columns: Column<PostingGroupRowDto>[] = [
    { key: "period", header: "Period", sortable: true, mobile: "title", className: "whitespace-nowrap", cell: (r) => <Link href={withGroup(r.id)} scroll={false} className={LINK}>{periodText(r)}</Link> },
    { key: "key", header: "Group key", mobile: "meta", cell: (r) => groupKeyText(r.keys) },
    { key: "items", header: "Items", align: "right", mobile: "meta", cell: (r) => <span className="tabular">{formatNumber(r.items)}</span> },
    { key: "total", header: "Total", align: "right", mobile: "meta", className: "whitespace-nowrap", cell: (r) => <span className="tabular">{amountText(r.totalMinor, r.currency)}<span className="ml-1 text-caption text-fg-3">{r.currency}</span></span> },
    { key: "status", header: "Status", mobile: "meta", hideable: false, cell: (r) => { const c = groupChip(r); return <StatusChip health={c.health} label={c.label} />; } },
    { key: "sends", header: "Sends", mobile: "meta", className: "whitespace-nowrap", cell: (r) => sendsAtText(r) },
    { key: "action", header: "Action", mobile: "hidden", defaultHidden: true, cell: (r) => <span className="grid"><span>{r.action}</span><span className="text-caption text-fg-3">{r.variant}</span></span> },
  ];
  return (
    <>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the posting groups; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      <Panel flush icon={LogIcon} title="Posting groups" count={t.count} description="Approved items a grouped posting sends as one call, newest period first"
        toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}>
        <DataTable label="Posting groups" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load the posting groups", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={{ icon: LogIcon, title: "No posting groups yet", description: "A group appears when an item is approved under a posting variant that sends grouped." }} />
      </Panel>
      {open && <GroupDialog spaceId={spaceId} configId={id} groupId={open} onClose={() => router.replace(withGroup(null), { scroll: false })} />}
    </>
  );
}
