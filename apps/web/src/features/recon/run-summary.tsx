"use client";

import type { ReactNode } from "react";
import { StatTile, StatTiles, StatusChip } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { cn } from "@starterkit/ui/lib/cn";
import { formatTime, APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { isLive, itemsText, projectionText, rangeText, rateText, standingTotals, STOPPED_CHIP, stoppedLine } from "./run-model";
import { STALL_TEXT } from "./use-recons";

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
        {day && <span className="text-caption text-fg-3 tabular">At day close: {day}</span>}
      </div>
      {action}
      {/* the counts as numbers to scan, not a sentence to read (owner, 22 Nov: law of Prägnanz); dimmed while it runs */}
      {run.status !== "failed" && (
        <StatTiles className={cn("basis-full rounded-md border-0 bg-transparent p-0", live && "opacity-60")}>
          <StatTile label="Matched" value={formatNumber(t.matched)} caption={t.rate === null ? "Pairs and groups" : `Match rate ${rateText(t.rate)}`} />
          <StatTile label="Suggested" value={formatNumber(t.suggested)} caption="Open until someone accepts them" />
          <StatTile label="Waiting" value={formatNumber(t.waiting.a + t.waiting.b)} caption={`${formatNumber(t.waiting.a)} ${labels[0]} · ${formatNumber(t.waiting.b)} ${labels[1]}`} />
          <StatTile label="Unmatch" value={formatNumber((t.breaks ? t.breaks.a + t.breaks.b : 0) + t.duplicate + t.ambiguous)}
            caption={t.duplicate ? `${formatNumber(t.duplicate)} duplicate · need review` : "Need review"} />
        </StatTiles>
      )}
    </section>
  );
}
