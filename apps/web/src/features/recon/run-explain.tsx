"use client";

import { useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import type { ReconRunItemDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { amountText, differenceText, evidenceOf, rangeText } from "./run-model";
import { conditionText, type Fields, pairText } from "./spec-model";

const KIND: Record<string, string> = { auto: "Matched", suggested: "Suggested", manual: "Matched by hand", force: "Forced" };
/** How the engine chose a group (engine sql/pass.ts CHOSEN), in plain words; anything else is left out. */
const CHOSEN: Record<string, string> = {
  "mutual unique best": "the best pair on both sides",
  "duplicates paired in order: business date, event time, record id": "repeated references paired in order of date and time",
  "tie broken by business date, event time, record id": "equal candidates, the earliest taken",
  "group sum, one counterpart": "the group's sum equals its counterpart",
};

/**
 * Explain (list view, Task 5; the graph follows in Task 7): why a group is a group. Its members on both sides, how the
 * pass found them, and each condition of the pass with what it saw (side B − side A). Loaded on demand (next/dynamic).
 */
export default function RunExplain({ item, spec, fields, labels, onShown, returnFocus, onClose }: {
  item: ReconRunItemDto; spec: ReconSpec; fields: Fields; labels: readonly [string, string];
  /** The dialog's code has loaded (the Explain button stops its pending state). */
  onShown: () => void;
  /** Focus back to the row's Explain button. */
  returnFocus: () => void;
  onClose: () => void;
}) {
  useEffect(() => { onShown(); }, [onShown]);
  const g = item.group!;
  const pass = spec.passes.find((p) => p.no === g.passNo);
  const ev = evidenceOf(g.evidence);
  const ccy = g.members[0]?.currency ?? null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent onCloseAutoFocus={(e) => { e.preventDefault(); returnFocus(); }}>
        <DialogHeader>
          <DialogTitle>Pass {g.passNo}{pass ? ` · ${pass.name}` : ""}</DialogTitle>
          <DialogDescription>{[KIND[g.kind] ?? g.kind, rangeText(g.businessDate, g.businessDate), ev.chosen ? CHOSEN[ev.chosen] ?? "" : ""].filter(Boolean).join(" · ")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5 text-body-sm">
          <section aria-label="Items" className="grid gap-1">
            {g.members.map((m) => (
              <p key={m.recordId} className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="w-24 shrink-0 text-fg-3">{m.side === "a" ? labels[0] : labels[1]}</span>
                <span className="font-mono text-mono text-fg">{m.extRef ?? "—"}</span>
                <span className="text-fg-2">{rangeText(m.businessDate, m.businessDate)}</span>
                <span className="tabular text-fg">{amountText(m.amountMinor, m.currency)} {m.currency}</span>
              </p>
            ))}
          </section>
          {pass && (
            <section aria-label="Conditions" className="grid gap-1.5 border-t border-line pt-3">
              {pass.blocking.length > 0 && <p className="text-fg-2">Candidates by {pass.blocking.map((f) => pairText(f, fields)).join(", ")}</p>}
              {pass.predicates.map((q, j) => {
                const seen = ev.predicates?.[j];
                const diff = seen ? differenceText({ predicates: [seen] }, ccy) : "";
                return (
                  <p key={j} className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-mono text-mono text-fg wrap-anywhere">{conditionText(q, fields)}</span>
                    <span className="text-fg-3">{seen ? (seen.passed ? "Passed" : "Failed") : "—"}{diff ? ` · ${diff}` : ""}</span>
                  </p>
                );
              })}
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
