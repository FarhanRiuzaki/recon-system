"use client";

import type { ReactNode } from "react";
import { StatusChip } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { formatTime, APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { isLive, itemsText, projectionText, rangeText, runLine, standingTotals, STOPPED_CHIP, stoppedLine } from "./run-model";
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
        {run.status !== "failed" && <span className={cn("text-caption text-fg-3 tabular", live && "opacity-60")}>{runLine(run, spec, labels)}</span>}
        {day && <span className="text-caption text-fg-3 tabular">At day close: {day}</span>}
      </div>
      {action}
    </section>
  );
}
