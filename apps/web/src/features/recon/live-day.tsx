"use client";

// A recon's Live day tab (REC-F4, spec §11a "Live day"): its current business date as its last live run left it, the
// run's freshness, the day's pipeline (the builder canvas, read-only, its edges counting the day; its source nodes say
// each source's health and lag) with a list view of the same numbers, and the sources. Read again every LIVE_POLL_MS;
// a number that changes tweens once (reduced motion: no tween, StatTile's own rule).
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { EmptyState, Failure, Notice, Panel, RelativeTime, Segmented, StatTile, StatTiles, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatDate, formatDateTime, formatNumber } from "@starterkit/ui/lib/format";
import { ComponentsIcon } from "@starterkit/ui/ui/icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import { BRAND } from "@starterkit/shared/brand";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import { LoadingShape } from "@/components/route-skeleton";
import { breakLabel } from "./run-model";
import { CanvasLoader } from "./canvas-loader";
import { useArrivals, useElapsed } from "./live-hooks";
import { dayCounters, dayTotals, reconChip, scheduleLine, sourceChip, sourceLag } from "./live-model";
import { LIVE_DAY_SHAPE } from "./shapes";
import { useReconLive } from "./use-recons";

const fmt = (v: number) => formatNumber(Math.round(v));

/** `between`: what sits under the day's numbers, before the pipeline (the Overview's run card, history and trend). */
export function LiveDay({ spaceId, id, spec, between }: { spaceId: string; id: string; spec: ReconSpec | null; between?: ReactNode }) {
  const q = useReconLive(spaceId, id, !!spec);
  const skeleton = useDelayedFlag(!!spec && !q.data && !q.error);
  const elapsed = useElapsed(q.data?.recon.running?.status === "running" ? q.data.recon.running.startedAt : null);
  // a source whose records grew since the last read: its records are coming in (owner, 22 Nov)
  const arrivals = useArrivals(q.data?.sources);
  const sp = useSearchParams(), pathname = usePathname();
  const view: "pipeline" | "list" = sp.get("view") === "list" ? "list" : "pipeline";
  const setView = (v: "pipeline" | "list") => {
    const next = new URLSearchParams(window.location.search);
    if (v === "list") next.set("view", "list"); else next.delete("view");
    window.history.replaceState(null, "", `${pathname}?${next}`);
  };

  if (!spec) return <Panel><EmptyState icon={ComponentsIcon} title="No approved version running yet" description="The live day shows here once a config checker approves the recon's first version." /></Panel>;
  if (q.error && !q.data) return <Panel><Failure title="The live day couldn't be loaded." error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel>;
  const live = q.data;
  if (!live || skeleton) return <LoadingShape sections={LIVE_DAY_SHAPE.slice(2)} shown={skeleton} />;
  const r = live.recon, byId = new Map(live.sources.map((s) => [s.id, s]));
  const chip = reconChip(r, byId), tot = dayTotals(r);
  const keys = spec.passes.map((_, i) => `p${i}`);
  const src = r.sides.map((s) => byId.get(s.sourceId));
  const sourceLines = src.map((s) => (!s ? "Not readable from this space" : arrivals.get(s.id) ? `+${formatNumber(arrivals.get(s.id)!)} records just in` : `${sourceChip(s).label} · ${sourceLag(s)}`)) as [string, string];
  const arriving = [!!(src[0] && arrivals.get(src[0].id)), !!(src[1] && arrivals.get(src[1].id))] as const;
  const run = r.running ? (r.running.status === "running" ? `Running for ${elapsed}` : "A run is queued") : null;

  return (
    <div className="grid gap-section">
      {q.error && <Notice tone="warn" live>Couldn&apos;t refresh the live day; showing what was read <RelativeTime at={q.dataUpdatedAt} />.</Notice>}
      {r.stale && (
        <Notice tone="warn">
          No successful scheduled run {r.lastSuccessAt ? `since ${formatDateTime(Date.parse(r.lastSuccessAt))}` : "yet"}: more than twice its interval.
          {r.alertedAt ? ` Last alert ${formatDateTime(Date.parse(r.alertedAt))}.` : ""}
        </Notice>
      )}
      <Panel flush title={<span className="flex flex-wrap items-center gap-2">Business date {formatDate(Date.parse(`${r.date}T00:00:00+07:00`))}<StatusChip health={chip.health} label={chip.label} /></span>}
        description={[scheduleLine(r.schedule), run ?? (r.runAt ? `last run finished ${formatDateTime(Date.parse(r.runAt))}` : "no run has covered this date yet")].join(" · ")}>
        {/* the tiles fill the card: its body is the tray (no second frame) */}
        <StatTiles className="rounded-none border-0">
          <StatTile label="Items in" value={tot?.inItems != null ? fmt(tot.inItems) : "—"} tween={tot?.inItems != null ? { value: tot.inItems, format: fmt } : undefined} caption="Both sides, this date" />
          <StatTile label="Matched" value={tot ? fmt(tot.matched) : "—"} tween={tot ? { value: tot.matched, format: fmt } : undefined} caption="Pairs and groups" />
          <StatTile label="Waiting" value={tot ? fmt(tot.waiting) : "—"} tween={tot ? { value: tot.waiting, format: fmt } : undefined}
            caption={tot ? `${formatNumber(tot.suggested)} suggested, open until accepted` : "Open items of this date"} />
          <StatTile label="Unmatch" value={fmt(r.openBreaks)} tween={{ value: r.openBreaks, format: fmt }} caption={tot ? `${formatNumber(tot.breaks)} unmatch on this date` : "Every date"} />
        </StatTiles>
      </Panel>

      {between}

      <Panel flush title="Pipeline" description={r.day ? "The passes in run order and where this date's items went" : "Counts appear once a run covers this date"}
        actions={<span className="max-md:hidden"><Segmented label="Show the pipeline as" value={view} onChange={setView} options={[{ value: "pipeline", label: "Pipeline" }, { value: "list", label: "List" }]} /></span>}>
        {view === "pipeline" && (
          <div className="max-md:hidden">
            <CanvasLoader spec={spec} keys={keys} counters={dayCounters(r)} dim={false} selectedId={null} editable={false} sourceLines={sourceLines} running={r.running?.status === "running"} arriving={arriving}
              label="The live day's pipeline: sources, sides, passes in run order and where the date's items went" />
          </div>
        )}
        {/* the list view: the same numbers, by keyboard and screen reader; a phone's only view (DEC-041) */}
        <div className={view === "pipeline" ? "md:hidden" : undefined}>
          <Table aria-label="Passes of the live day">
            <TableHeader><TableRow>
              <TableHead>Pass</TableHead><TableHead className="text-right">Matched</TableHead><TableHead className="text-right">Suggested</TableHead><TableHead className="text-right">Broken</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {spec.passes.map((p, i) => {
                const x = r.day?.passes[String(p.no)];
                return (
                  <TableRow key={p.no}>
                    <TableCell>{i + 1}. {p.name || "Untitled pass"}</TableCell>
                    <TableCell className="text-right tabular">{x ? formatNumber(x.matched) : "—"}</TableCell>
                    <TableCell className="text-right tabular">{x ? formatNumber(x.suggested) : "—"}</TableCell>
                    <TableCell className="text-right tabular">{x ? `${formatNumber(x.broken)}${x.broken ? ` ${breakLabel(p).toLowerCase()}` : ""}` : "—"}</TableCell>
                  </TableRow>
                );
              })}
              <TableRow>
                <TableCell className="text-fg-2">Waiting after the passes</TableCell>
                <TableCell colSpan={3} className="text-right tabular">{r.day ? `${formatNumber(r.day.open.a)} ${r.sides[0].label} · ${formatNumber(r.day.open.b)} ${r.sides[1].label}` : "—"}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Panel>

      <Panel flush title="Sources" description="What each side reads, how far it is and what came in for its business date">
        <Table aria-label="Sources of the live day">
          <TableHeader><TableRow>
            <TableHead>Side</TableHead><TableHead>Source</TableHead><TableHead>Health</TableHead><TableHead>How far</TableHead><TableHead className="text-right">Records today</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {r.sides.map((side, i) => {
              const s = src[i];
              return (
                // records just came in: the row flashes once and the count says how many (the new-row flash, reduced motion: none)
                <TableRow key={`${i}-${s && arrivals.get(s.id) ? s.rowsToday : 0}`} className={s && arrivals.get(s.id) ? "motion-safe:animate-row-new" : undefined}>
                  <TableCell className="whitespace-nowrap text-fg-2">Side {i === 0 ? "A" : "B"} · {side.label}</TableCell>
                  <TableCell>{s?.name ?? "Not readable from this space"}</TableCell>
                  <TableCell>{s && <StatusChip health={sourceChip(s).health} label={sourceChip(s).label} />}</TableCell>
                  <TableCell className="whitespace-nowrap text-fg-2">{s ? sourceLag(s) : "—"}</TableCell>
                  <TableCell className="text-right tabular">
                    {s && arrivals.get(s.id) ? <span className="mr-2 text-caption text-healthy-ink">+{formatNumber(arrivals.get(s.id)!)}</span> : null}
                    {s?.rowsToday != null ? formatNumber(s.rowsToday) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}
