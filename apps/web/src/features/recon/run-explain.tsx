"use client";

import { useEffect } from "react";
import { StatusChip } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import type { ReconRunItemDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { amountText, carryOverText, counterpartWindow, differenceText, evidenceOf, rangeText } from "./run-model";
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
  const close = { onOpenChange: (o: boolean) => { if (!o) onClose(); } };
  const focusBack = (e: Event) => { e.preventDefault(); returnFocus(); };
  if (!item.group) {
    // a break with no counterpart (designer): its own record, and where the other side had nothing; no conditions
    const own = item.side === "a" ? labels[0] : labels[1], other = item.side === "a" ? labels[1] : labels[0];
    return (
      <Dialog open {...close}>
        <DialogContent className="max-w-160" onCloseAutoFocus={focusBack}>
          <DialogHeader>
            <DialogTitle>{item.breakReason ?? "Break"}</DialogTitle>
            <DialogDescription>Break · {rangeText(item.businessDate, item.businessDate)} · left open at day close</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 px-6 py-5 text-body-sm">
            <div className="grid gap-3 md:grid-cols-2">
            <section aria-label={own} className="grid content-start gap-2 rounded-md border border-line bg-card p-3">
              <h3 className="text-caption text-fg-3">{own}</h3>
              <span className="text-title-2 tabular text-fg">{amountText(item.amountMinor, item.currency)} {item.currency}</span>
              <span className="font-mono text-mono text-fg">{item.extRef ?? "—"}</span>
              <span className="text-fg-2">{rangeText(item.businessDate, item.businessDate)}</span>
            </section>
            {/* the other side's column: a dashed card, nothing to compare (Figma 206:6372) */}
            <section aria-label={other} className="grid content-start gap-2 rounded-md border border-dashed border-line p-3">
              <h3 className="text-caption text-fg-3">{other}</h3>
              <p className="text-fg-2">No item with reference <span className="font-mono text-mono text-fg">{item.extRef ?? "—"}</span> on {counterpartWindow(item.businessDate, spec.carry_over_days)}.</p>
            </section>
            </div>
            <p className="text-fg-2">{carryOverText(item.businessDate, spec.carry_over_days)}</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }
  const g = item.group;
  const pass = spec.passes.find((p) => p.no === g.passNo);
  const ev = evidenceOf(g.evidence);
  const ccy = g.members[0]?.currency ?? null;
  // what differs (side B − side A), from the evidence: marks side B's amount or date
  const preds = ev.predicates ?? [];
  const moved = (ops: readonly string[]) => preds.some((x) => ops.includes(x.op) && x.delta !== null && x.delta !== undefined && Number(x.delta) !== 0);
  const diff = { amount: moved(["amount_abs_tol", "amount_pct_tol", "eq_sum"]), date: moved(["date_window", "bday_window"]), text: differenceText(g.evidence, ccy) };
  return (
    <Dialog open {...close}>
      <DialogContent className="max-w-160" onCloseAutoFocus={focusBack}>
        <DialogHeader>
          <DialogTitle>Pass {g.passNo}{pass ? ` · ${pass.name}` : ""}</DialogTitle>
          <DialogDescription>{[KIND[g.kind] ?? g.kind, rangeText(g.businessDate, g.businessDate), ev.chosen ? CHOSEN[ev.chosen] ?? "" : ""].filter(Boolean).join(" · ")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5 text-body-sm">
          {/* the two records side by side, as the break page compares them (Figma 174:20748); side B's differing values marked */}
          <div className="grid gap-3 md:grid-cols-2">
            {(["a", "b"] as const).map((side) => (
              <section key={side} aria-label={side === "a" ? labels[0] : labels[1]} className="grid content-start gap-2 rounded-md border border-line bg-card p-3">
                <h3 className="text-caption text-fg-3">{side === "a" ? labels[0] : labels[1]}</h3>
                {g.members.filter((m) => m.side === side).map((m) => (
                  <div key={m.recordId} className="grid gap-0.5">
                    <span className={cn("text-title-2 tabular", side === "b" && diff.amount ? "text-degraded-ink" : "text-fg")}>{amountText(m.amountMinor, m.currency)} {m.currency}</span>
                    <span className="font-mono text-mono text-fg">{m.extRef ?? "—"}</span>
                    <span className={side === "b" && diff.date ? "text-degraded-ink" : "text-fg-2"}>{rangeText(m.businessDate, m.businessDate)}</span>
                  </div>
                ))}
                {side === "b" && g.memberCount > g.members.length && <p className="text-caption text-fg-3">{g.memberCount - g.members.length} more items not listed</p>}
                {side === "b" && diff.text && <p className="text-caption text-degraded-ink">{diff.text}</p>}
              </section>
            ))}
          </div>
          {pass && (
            <section aria-label="Conditions" className="grid gap-2">
              {pass.blocking.length > 0 && <p className="text-fg-2">Candidates by {pass.blocking.map((f) => pairText(f, fields)).join(", ")}</p>}
              {pass.predicates.map((q, j) => {
                const seen = ev.predicates?.[j];
                const d = seen ? differenceText({ predicates: [seen] }, ccy) : "";
                return (
                  <p key={j} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {seen && <StatusChip health={seen.passed ? "healthy" : "down"} label={seen.passed ? "Pass" : "Fail"} />}
                    <span className="font-mono text-mono text-fg wrap-anywhere">{conditionText(q, fields)}</span>
                    {d && <span className="text-caption text-fg-3">{d}</span>}
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
