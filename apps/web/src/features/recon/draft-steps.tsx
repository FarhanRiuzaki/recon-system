"use client";

import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import { CheckIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import type { DraftStep } from "./spec-model";

const MARK: Record<DraftStep["state"], string> = {
  done: "bg-healthy-soft text-healthy-ink", attention: "bg-degraded-soft text-degraded-ink", todo: "bg-tray text-fg-2",
};

/**
 * A draft's progress (owner, 22 Nov): its five steps in order, each saying where it stands; choosing one opens its
 * place (a side, a pass, the schedule, the simulation, the submit). The state is said in words too, never colour alone.
 */
export function DraftSteps({ steps, onPick }: { steps: readonly DraftStep[]; onPick: (key: DraftStep["key"]) => void }) {
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <nav aria-label={`Draft progress: ${done} of ${steps.length} done`} className="rounded-lg border border-line bg-card p-2 shadow-xs">
      <ol className="grid gap-1 md:grid-cols-5">
        {steps.map((s, i) => (
          <li key={s.key} className="min-w-0">
            <button type="button" onClick={() => onPick(s.key)}
              className="grid h-full w-full grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-2.5 rounded-md p-2.5 text-left hover:bg-tray focus-visible:outline-2 focus-visible:outline-primary">
              <span aria-hidden="true" className={cn("grid size-7 place-items-center rounded-full text-caption tabular", MARK[s.state])}>
                {s.state === "done" ? <Icon icon={CheckIcon} size={14} /> : s.state === "attention" ? <Icon icon={WarningIcon} size={14} /> : i + 1}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="text-label text-fg">{s.title}<span className="sr-only">{s.state === "done" ? ", done" : s.state === "attention" ? ", needs attention" : ", to do"}</span></span>
                <span className={cn("text-caption", s.state === "attention" ? "text-degraded-ink" : "text-fg-3")}>{s.line}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
