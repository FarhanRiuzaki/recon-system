"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { StatusChip } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { formatTime, APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { isLive, itemsText, projectionText, rangeText, runLine, standingTotals, STOPPED_CHIP, stoppedLine } from "./run-model";
import { dayTilesOf, RunDayTiles } from "./run-days";
import { reconRunHref, STALL_TEXT } from "./use-recons";

/** A run in one strip (the run page's head, the recon's last run on its Overview): its state, dates, counts and what day close does; `action` ends the strip. */
export function RunSummary({ run, spec, labels, stalled = false, action }: { run: ReconRunDto; spec: ReconSpec; labels: readonly [string, string]; stalled?: boolean; action?: ReactNode }) {
  const t = standingTotals(run, spec);
  const live = isLive(run);
  const chip = live ? { health: "unknown" as const, label: "Running" } : run.status === "failed" ? STOPPED_CHIP
    : { health: "healthy" as const, label: run.mode === "simulation" ? "Simulated" : "Done" };
  const what = run.mode === "simulation" ? `Draft v${run.version}` : `Version ${run.version}`;
  const at = run.finishedAt ? ` · ${formatTime(Date.parse(run.finishedAt))} ${APP_TIME_ZONE_LABEL}` : "";
  const day = run.projection ? projectionText(run.projection, labels) : "";
  return (
    <section aria-label="Run" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-card p-4 shadow-xs">
      <StatusChip health={chip.health} label={chip.label} />
      <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
        {/* the live region is the state line only: the counts change with every poll; the counts are what stands now */}
        <span role="status" className="text-body-sm text-fg">
          {run.status === "failed" ? stoppedLine(run) : `${what} · ${rangeText(run.from, run.to)} · ${itemsText(t.items)}${at}`}{stalled ? ` · ${STALL_TEXT}` : ""}
        </span>
        {run.status !== "failed" && <span className={cn("text-caption text-fg-3 tabular", live && "opacity-60")}>{runLine(run, spec, labels)}</span>}
        {day && <span className="text-caption text-fg-3 tabular">At day close: {day}</span>}
      </div>
      {action}
    </section>
  );
}

/**
 * A published recon's Overview headline (Captain, R6-1): the last run that processed records (its own dates' current
 * records, `live.items`), titled by its dates and time ("Run 2–5 Nov · 08:06 WIB"), the run page's own line under it,
 * its date strip over its own dates (each tile opens that date of the run) and Open run; a newer run is one small line
 * under it ("Last run 08:55 · no new records"), never the headline. A headline still running, stopped, or without
 * records (no run has processed any yet) reads as a run's strip (RunSummary).
 */
export function LastRun({ spaceId, id, run, newer, spec, labels }: {
  spaceId: string; id: string; run: ReconRunDto; newer: ReconRunDto | null; spec: ReconSpec; labels: readonly [string, string];
}) {
  const href = reconRunHref(spaceId, id, run.id);
  const open = <Button asChild variant="secondary"><Link href={href}>Open run</Link></Button>;
  const records = run.live?.items ? run.live.items.a + run.live.items.b : standingTotals(run, spec).items;
  const settled = run.status === "succeeded" && records > 0;
  const at = run.finishedAt ? ` · ${formatTime(Date.parse(run.finishedAt))} ${APP_TIME_ZONE_LABEL}` : "";
  const tiles = dayTilesOf(run, spec, { own: true });
  return (
    <section aria-label="Last run" className="grid gap-3">
      {settled ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-card p-4 shadow-xs">
          <StatusChip health="healthy" label="Done" />
          <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
            <span className="text-body-sm text-fg">Run {rangeText(run.from, run.to).replace(/ \d{4}$/, "")}{at}</span>
            <span className="text-caption text-fg-3 tabular">{runLine(run, spec, labels)}</span>
          </div>
          {open}
        </div>
      ) : <RunSummary run={run} spec={spec} labels={labels} action={open} />}
      {settled && tiles.length > 1 && <RunDayTiles tiles={tiles} labels={labels} link={(date) => ({ href: date ? `${href}?date=${date}` : href })} />}
      {newer && (
        <Link href={reconRunHref(spaceId, id, newer.id)} className="justify-self-start rounded-xs text-caption text-fg-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-primary">
          Last run {formatTime(Date.parse(newer.finishedAt ?? newer.startedAt))} · {isLive(newer) ? "running" : newer.status === "failed" ? "stopped" : "no new records"}
        </Link>
      )}
    </section>
  );
}
