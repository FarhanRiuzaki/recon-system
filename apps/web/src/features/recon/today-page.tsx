"use client";

// Today (/spaces/[spaceId]/today, REC-F4, spec §11a): the Space map (sources → recons, a Degraded or Down source marks
// the recons it feeds) with a list view of the same content, and the recons table (each recon's current business
// date, its run, its numbers). Read again every LIVE_POLL_MS (plan 4 decision 2).
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChunkBoundary } from "@starterkit/ui/ds/chunk-boundary";
import { EmptyState, Failure, Notice, Panel, RelativeTime, Segmented, StatTile, StatTiles, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatDate, formatNumber } from "@starterkit/ui/lib/format";
import { BranchIcon } from "@starterkit/ui/ui/icons";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import { BRAND } from "@starterkit/shared/brand";
import type { TodayDto } from "@starterkit/shared/contracts/recon";
import { selectionState } from "@starterkit/shared/filter-selection";
import { attentionText } from "@/lib/shared/posting";
import { TODAY_RECONS_MAX } from "@starterkit/shared/recon";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { StateChip } from "@/components/state-chip";
import { dayTotals, reconChip, scheduleLine, sourceChip, sourceLag, spaceMap, todayKpis } from "./live-model";
import { TODAY_SHAPE } from "./shapes";
import { useArrivals } from "./live-hooks";
import { reconHref, reconsHref, useMyApprovals, useToday } from "./use-recons";

function MapShape() {
  return (
    <div className="grid h-80 grid-cols-2 gap-16 p-6" aria-busy="true" aria-label="Loading the space map">
      {[3, 3].map((n, l) => <div key={l} className="grid content-center gap-4">{Array.from({ length: n }, (_, i) => <Skeleton key={i} className="h-19 rounded-md" />)}</div>)}
    </div>
  );
}
const SpaceMap = dynamic(() => import("./space-map").then((m) => m.SpaceMap), { ssr: false, loading: MapShape });
/** A recon's Overview: its day, runs and trend (Live day merged into it). */
const liveHref = reconHref;

/** The map's list view: each source with its health, lag and the recons that read it (the same content, by keyboard and screen reader). */
function MapList({ t, spaceId }: { t: TodayDto; spaceId: string }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="Sources and the recons that read them">
      {t.sources.map((s) => {
        const chip = sourceChip(s), readers = t.recons.filter((r) => r.sides.some((x) => x.sourceId === s.id));
        return (
          <li key={s.id} className="grid content-start gap-2 rounded-md border border-line bg-card p-3">
            <span className="flex items-center justify-between gap-2"><span className="truncate text-body-sm text-fg">{s.name}</span><StatusChip health={chip.health} label={chip.label} /></span>
            <span className="text-caption text-fg-3">{sourceLag(s)}{s.rowsToday != null ? ` · ${formatNumber(s.rowsToday)} today` : ""}</span>
            <span className="text-caption text-fg-2">Read by {readers.map((r, i) => (
              <span key={r.id}>{i > 0 && ", "}<Link className="text-fg underline-offset-4 hover:underline" href={liveHref(spaceId, r.id)}>{r.name}</Link></span>
            ))}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function TodayPage({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const q = useToday(spaceId);
  const waiting = useMyApprovals(spaceId);
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const arrivals = useArrivals(q.data?.sources);
  const sp = useSearchParams(), pathname = usePathname();
  const view: "map" | "list" = sp.get("view") === "list" ? "list" : "map";
  const setView = (v: "map" | "list") => {
    const next = new URLSearchParams(window.location.search);
    if (v === "list") next.set("view", "list"); else next.delete("view");
    window.history.replaceState(null, "", next.size ? `${pathname}?${next}` : pathname);
  };

  const header = <PageHeader title="Today" description={`${spaceName} · the recons' current business dates, read again every 15 seconds (every 5 while a run is under way)`} />;
  if (q.error && !q.data) return <div className="grid gap-section">{header}<Panel><Failure title="Today couldn't be loaded." error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  const t = q.data;
  if (!t || skeleton) return <LoadingShape sections={TODAY_SHAPE} shown={skeleton} />;
  const byId = new Map(t.sources.map((s) => [s.id, s]));
  const attention = new Map(t.posting.map((p) => [p.reconId, p]));
  const postingHref = `/spaces/${encodeURIComponent(spaceId)}/posting?status=${encodeURIComponent(selectionState(["failed", "timeout", "not_sent"]))}&kind=posting`;
  const map = spaceMap(t, (id) => liveHref(spaceId, id), arrivals);
  const affected = map.nodes.filter((n) => n.affectedBy?.length).length;
  const k = todayKpis(t);

  return (
    <div className="grid gap-section">
      {header}
      {q.error && <Notice tone="warn" live>Couldn&apos;t refresh Today; showing what was read <RelativeTime at={q.dataUpdatedAt} />.</Notice>}
      {/* the space at a glance first (audit T1): what needs someone today */}
      <StatTiles>
        <StatTile label="Unmatch open" value={formatNumber(k.unmatch)} caption="Every date of these recons" />
        <StatTile label="Waiting for my approval" value={waiting.data ? formatNumber(waiting.data.total) : "—"} caption={waiting.error && !waiting.data ? "Couldn't load the approvals" : undefined} />
        <StatTile label="Postings needing attention" value={formatNumber(k.posting)} caption="Failed, timeout or not sent in 24 h" />
        <StatTile label="Sources behind" value={formatNumber(k.behind)} caption={`Degraded or down, of ${formatNumber(t.sources.length)}`} />
      </StatTiles>
      {t.capped && <Notice>The space has more than {formatNumber(TODAY_RECONS_MAX)} recons; Today shows the first {formatNumber(TODAY_RECONS_MAX)} by name.</Notice>}
      {!t.recons.length ? (
        <Panel><EmptyState icon={BranchIcon} title="No recon is running in this space yet"
          description="Today lists a recon once a config checker approves its first version." action={<Link className="text-primary underline-offset-4 hover:underline" href={reconsHref(spaceId)}>Open recons</Link>} /></Panel>
      ) : (
        <>
          <Panel flush title="Space map" description={affected ? `${affected} ${affected === 1 ? "recon reads" : "recons read"} a source that is degraded or down` : "Sources and the recons that read them"}
            actions={<span className="max-md:hidden"><Segmented label="Show the space map as" value={view} onChange={setView} options={[{ value: "map", label: "Map" }, { value: "list", label: "List" }]} /></span>}>
            {view === "map" && <div className="max-md:hidden"><ChunkBoundary><SpaceMap nodes={map.nodes} edges={map.edges} /></ChunkBoundary></div>}
            {/* a phone always reads the list (DEC-041) */}
            <div className={view === "map" ? "p-4 md:hidden" : "p-4"}><MapList t={t} spaceId={spaceId} /></div>
          </Panel>

          <Panel flush title="Recons" count={t.recons.length} description="Each recon's current business date as its last run left it">
            <Table aria-label="Recons of the space today">
              <TableHeader><TableRow>
                <TableHead>Recon</TableHead><TableHead>Business date</TableHead><TableHead>Last run</TableHead>
                <TableHead className="text-right">Matched</TableHead><TableHead className="text-right">Suggested</TableHead>
                <TableHead className="text-right">Waiting</TableHead><TableHead className="text-right">Unmatch</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {t.recons.map((r) => {
                  const chip = reconChip(r, byId), tot = dayTotals(r);
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <span className="grid gap-0.5">
                          <Link className="text-fg underline-offset-4 hover:underline" href={liveHref(spaceId, r.id)}>{r.name}</Link>
                          <span className="text-caption text-fg-3">{scheduleLine(r.schedule)}</span>
                          {attention.get(r.id) && (
                            <Link className="text-caption text-down-ink underline-offset-4 hover:underline" href={postingHref}>Posting: {attentionText(attention.get(r.id)!)} in 24 h</Link>
                          )}
                        </span>
                      </TableCell>
                      <TableCell><span className="flex items-center gap-2 whitespace-nowrap">{formatDate(Date.parse(`${r.date}T00:00:00+07:00`))}<StateChip chip={chip} /></span></TableCell>
                      <TableCell className="whitespace-nowrap text-fg-2">
                        {r.running ? (r.running.status === "running" ? "Running now" : "Queued")
                          : r.lastSuccessAt ? <RelativeTime at={Date.parse(r.lastSuccessAt)} /> : "No run yet"}
                      </TableCell>
                      <TableCell className="text-right tabular">{tot ? formatNumber(tot.matched) : "—"}</TableCell>
                      <TableCell className="text-right tabular">{tot ? formatNumber(tot.suggested) : "—"}</TableCell>
                      <TableCell className="text-right tabular">{tot ? formatNumber(tot.waiting) : "—"}</TableCell>
                      <TableCell className="text-right tabular">{formatNumber(r.openBreaks)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Panel>
        </>
      )}
    </div>
  );
}
