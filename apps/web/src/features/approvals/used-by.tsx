"use client";

import Link from "next/link";
import { useMemo } from "react";
import { type Column, ColumnsMenu, DataTable, Panel, Toolbar } from "@starterkit/ui/ds";
import { RankedListIcon } from "@starterkit/ui/ui/icons";
import type { UsedByRowDto } from "@starterkit/shared/contracts/workflows";
import { TRIGGER_LABEL } from "@starterkit/shared/workflows";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { usedByTable } from "@/lib/shared/queries-recon";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const STATUS = { published: "Live", draft: "Draft", in_review: "Waits for approval" } as const;
const COLUMNS: Column<UsedByRowDto>[] = [
  { key: "space", header: "Space", mobile: "title", cell: (r) => (
    <Link href={`/spaces/${encodeURIComponent(r.spaceId)}/approval-rules/${r.trigger}`} className={LINK}>{r.spaceName}</Link>
  ) },
  { key: "trigger", header: "Change", mobile: "meta", cell: (r) => TRIGGER_LABEL[r.trigger] },
  { key: "rule", header: "Rule", mobile: "meta", cell: (r) => r.ruleName },
  { key: "rules", header: "Rules version", mobile: "meta", className: "whitespace-nowrap", cell: (r) => `${r.rulesVersion} · ${STATUS[r.rulesStatus]}` },
  { key: "short", header: "People", mobile: "meta", hideable: false, cell: (r) => (r.short.length
    ? <span className="text-body-sm text-down-ink">Short of people at {r.short.join(", ")}</span>
    : <span className="text-body-sm text-fg-3">Enough</span>) },
];

/**
 * Which spaces' approval rules use a library workflow (DEC-052 revision §5), and where the levels on screen would lack
 * people (an approver counts only as an active member of the space): what a publish changes, before it is published.
 */
export function UsedBy({ id }: { id: string }) {
  const def = useMemo(() => usedByTable(id), [id]);
  const t = useTableQuery<UsedByRowDto, Record<string, never>>(def);
  return (
    <Panel flush icon={RankedListIcon} title="Used by" count={t.count}
      toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={COLUMNS} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}>
      <DataTable label="Approval rules using this workflow" columns={COLUMNS} hidden={t.hidden} rows={t.rows} rowKey={(r) => `${r.spaceId}:${r.trigger}:${r.rulesVersion}`}
        loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
        error={t.loadError ? { title: "Couldn't load where it is used", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
        empty={{ icon: RankedListIcon, title: "No approval rules use it", description: "A row appears when a space's approval rules pick this workflow." }} />
    </Panel>
  );
}
