"use client";

import Link from "next/link";
import { useMemo } from "react";
import { type Column, DataTable, Panel } from "@starterkit/ui/ds";
import { RankedListIcon } from "@starterkit/ui/ui/icons";
import type { UsedByRowDto } from "@starterkit/shared/contracts/workflows";
import { TRIGGER_LABEL } from "@starterkit/shared/workflows";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { usedByTable } from "@/lib/shared/queries-recon";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const STATUS = { published: "Live", draft: "Draft", in_review: "Waits for approval" } as const;
const columns = (spaceId: string): Column<UsedByRowDto>[] => [
  { key: "recon", header: "Recon", mobile: "title", cell: (r) => (
    <span className="grid min-w-0">
      <Link href={`/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(r.reconId)}`} className={LINK}>{r.reconName}</Link>
      <span className="text-caption text-fg-3">Version {r.reconVersion} · {STATUS[r.reconStatus]}</span>
    </span>
  ) },
  { key: "change", header: "Change", mobile: "meta", cell: (r) => TRIGGER_LABEL[r.change] },
  { key: "rules", header: "Rules", mobile: "meta", cell: (r) => r.rules.join(", ") },
  { key: "pinned", header: "Uses", mobile: "meta", className: "whitespace-nowrap", cell: (r) => (r.outdated
    ? <span className="text-body-sm text-degraded-ink">Version {r.pinned}, an older one</span>
    : <span className="text-body-sm text-fg-3">Version {r.pinned}</span>) },
];

/**
 * The recons of the space whose version (live or open) uses this workflow (DEC-052 rev 2 §5): for which change, by
 * which rules, at which version; a pin older than the live version is marked, since publishing doesn't move it.
 */
export function UsedBy({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => usedByTable(spaceId, id), [spaceId, id]);
  const COLUMNS = useMemo(() => columns(spaceId), [spaceId]);
  const t = useTableQuery<UsedByRowDto, Record<string, never>>(def);
  return (
    <Panel flush icon={RankedListIcon} title="Used by" count={t.count}>
      <DataTable label="Recons using this workflow" columns={COLUMNS} rows={t.rows} rowKey={(r) => `${r.reconId}:${r.reconVersion}:${r.change}`}
        loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
        error={t.loadError ? { title: "Couldn't load where it is used", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
        empty={{ icon: RankedListIcon, title: "No recon uses it yet", description: "A row appears once a recon's approval setup picks this workflow. Publishing a new version doesn't move a recon: it keeps the version it picked." }} />
    </Panel>
  );
}
