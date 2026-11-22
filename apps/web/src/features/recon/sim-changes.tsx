"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo } from "react";
import { type Column, ColumnsMenu, DataTable, Panel, Segmented, Toolbar } from "@starterkit/ui/ds";
import { formatDate, formatNumber } from "@starterkit/ui/lib/format";
import { ActivityIcon } from "@starterkit/ui/ui/icons";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconRunDto, ReconSimChangeDto, RunGroupMember } from "@starterkit/shared/contracts/recon";
import type { SimChange } from "@starterkit/shared/recon";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { api, errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { draftSimulations, reconSimChanges } from "@/lib/shared/queries-recon";
import { amountText } from "./run-model";
import { reconRunHref } from "./use-recons";

const CHANGE_LABEL: Record<SimChange, string> = { gained: "Gained", lost: "Lost", repaired: "Re-paired", kind: "Auto ↔ suggested" };
const CHANGE_HINT: Record<SimChange, string> = {
  gained: "Paired by this version, not by the live one",
  lost: "Paired by the live version, not by this one",
  repaired: "Paired by both, with a different counterpart",
  kind: "Paired by both, one matches it and the other only suggests it",
};
const dateText = (d: string) => formatDate(Date.parse(`${d}T00:00:00+07:00`));

/** One side of a changed pair: its pass and whether it matches or suggests, then its members (reference, amount). */
function Pair({ g }: { g: ReconSimChangeDto["draft"] }) {
  if (!g) return <span className="text-fg-3">Not paired</span>;
  const line = (m: RunGroupMember) => `${m.side.toUpperCase()} · ${m.extRef ?? "no reference"} · ${amountText(m.amountMinor, m.currency)}`;
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="text-caption text-fg-3">Pass {g.passNo} · {g.kind === "auto" ? "matches" : g.kind === "suggested" ? "suggests" : g.kind}</span>
      {g.members.slice(0, 2).map((m) => <span key={m.recordId} className="truncate font-mono text-caption text-fg-2" title={line(m)}>{line(m)}</span>)}
      {g.memberCount > 2 && <span className="text-caption text-fg-3">and {formatNumber(g.memberCount - 2)} more</span>}
    </span>
  );
}

/**
 * What a version in review changes against the live one, from its latest simulation (spec §10: the checker's diff):
 * the count of each kind of change, then the changed pairs, paged, one kind at a time. Before a version is live there
 * is nothing to compare: what the simulation did, with its results.
 */
export function SimChanges({ spaceId, id, versionId, live }: { spaceId: string; id: string; versionId: string; live: number | null }) {
  const sims = draftSimulations(spaceId, id, versionId);
  const runs = useQuery({ queryKey: sims.key, queryFn: () => api<Page<ReconRunDto>>(sims.url) });
  const run = runs.data?.items.find((r) => r.status === "succeeded") ?? null;
  if (runs.isPending) return null;
  const results = run && <Link href={reconRunHref(spaceId, id, run.id)} className="text-body-sm text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-primary">Open the simulation&apos;s results</Link>;
  if (!run) return <Panel title="What changes"><p className="text-body-sm text-fg-2">This version has no finished simulation.</p></Panel>;
  if (!live || !run.changes) {
    return (
      <Panel title="What changes" description={`Simulated over ${dateText(run.from)}${run.to !== run.from ? `–${dateText(run.to)}` : ""}`} actions={results}>
        <p className="text-body-sm text-fg-2">No version is live yet, so nothing is compared. The results show what this version pairs.</p>
      </Panel>
    );
  }
  return <ChangesTable spaceId={spaceId} id={id} run={run} live={live} results={results} />;
}

function ChangesTable({ spaceId, id, run, live, results }: { spaceId: string; id: string; run: ReconRunDto; live: number; results: React.ReactNode }) {
  const def = useMemo(() => reconSimChanges(spaceId, id, run.id), [spaceId, id, run.id]);
  const t = useTableQuery<ReconSimChangeDto, { change: string }>(def);
  const c = run.changes!;
  const total = c.gained + c.lost + c.repaired + c.kind;
  const columns: Column<ReconSimChangeDto>[] = [
    { key: "change", header: "Change", mobile: "title", className: "whitespace-nowrap", cell: (r) => <span title={CHANGE_HINT[r.change]}>{CHANGE_LABEL[r.change]}</span> },
    { key: "date", header: "Business date", mobile: "meta", className: "whitespace-nowrap", cell: (r) => dateText(r.businessDate) },
    { key: "draft", header: `This version`, mobile: "meta", className: "min-w-64", cell: (r) => <Pair g={r.draft} /> },
    { key: "published", header: `Version ${live}`, mobile: "meta", className: "min-w-64", cell: (r) => <Pair g={r.published} /> },
  ];
  const options = [{ value: "", label: `All ${formatNumber(total)}` },
    ...(["gained", "lost", "repaired", "kind"] as const).map((k) => ({ value: k, label: `${CHANGE_LABEL[k]} ${formatNumber(c[k])}` }))];
  return (
    <Panel flush title="What changes" count={total} description={`Against version ${live}, simulated over ${dateText(run.from)}${run.to !== run.from ? `–${dateText(run.to)}` : ""}`}
      actions={results}
      toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>
        <Segmented label="Show the changes" value={t.state.change} onChange={(change) => t.set({ change })} options={options} />
      </Toolbar>}>
      <DataTable label="Changed pairs" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
        error={t.loadError ? { title: "Couldn't load the changes", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
        empty={t.state.change
          ? { icon: ActivityIcon, title: `No ${CHANGE_LABEL[t.state.change as SimChange].toLowerCase()} pairs`, description: "Pick another kind of change to see its pairs." }
          : { icon: ActivityIcon, title: "Nothing changes", description: `Over these dates this version pairs exactly as version ${live} does.` }} />
    </Panel>
  );
}
