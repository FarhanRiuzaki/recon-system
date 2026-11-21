"use client";

import { useEffect } from "react";
import { StatusChip } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import type { ReconRunItemDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { amountText, carryOverText, differenceText, evidenceOf, lonePairText, pairDifference, rangeText } from "./run-model";
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
    // a break without a group: its record beside its proposed pair, or beside what day close looked for (Figma 206:6372)
    const p = item.proposed, by = p ? spec.passes.find((x) => x.no === p.passNo) : undefined;
    const a = item.side === "a" ? item : p, b = item.side === "a" ? p : item;
    const diff = p && a && b ? pairDifference(a, b) : "";
    // a pass broke it (Duplicate, Ambiguous): the other side wasn't compared; the reason goes under the cards (B4)
    const passBroke = item.breakReason === "Duplicate" || item.breakReason === "Ambiguous";
    const differs = { amount: !!p && p.amountMinor !== item.amountMinor, date: !!p && p.businessDate !== item.businessDate, ccy: !!p && p.currency !== item.currency };
    const card = (side: "a" | "b") => {
      const r = side === item.side ? item : p;
      const name = side === "a" ? labels[0] : labels[1];
      if (!r) {
        return (
          // the other side: a dashed card, nothing to compare
          <section key={side} aria-label={name} className="grid content-start gap-2 rounded-md border border-dashed border-line p-3">
            <h3 className="text-caption text-fg-3">{name}</h3>
            <p className="text-fg-2">{passBroke ? "Not compared." : lonePairText(item, spec.carry_over_days)}</p>
          </section>
        );
      }
      const marked = r === p; // the proposed record carries the marks of what differs
      return (
        <section key={side} aria-label={name} className="grid content-start gap-2 rounded-md border border-line bg-card p-3">
          <h3 className="text-caption text-fg-3">{name}</h3>
          <span className={cn("text-title-2 tabular", marked && (differs.amount || differs.ccy) ? "text-degraded-ink" : "text-fg")}>{amountText(r.amountMinor, r.currency)} {r.currency}</span>
          <span className="font-mono text-mono text-fg">{r.extRef ?? "—"}</span>
          <span className={marked && differs.date ? "text-degraded-ink" : "text-fg-2"}>{rangeText(r.businessDate, r.businessDate)}</span>
          {marked && diff && <p className="text-caption text-degraded-ink">{diff}</p>}
        </section>
      );
    };
    return (
      <Dialog open {...close}>
        <DialogContent className="max-w-160" onCloseAutoFocus={focusBack}>
          <DialogHeader>
            <DialogTitle>{item.breakReason ?? "Break"}</DialogTitle>
            <DialogDescription>
              Break · {rangeText(item.businessDate, item.businessDate)} · {p ? `pair proposed by pass ${p.passNo}${by ? ` · ${by.name}` : ""}` : item.breakPass ? `pass ${item.breakPass}` : "left open at day close"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 px-6 py-5 text-body-sm">
            <div className="grid gap-3 md:grid-cols-2">{card("a")}{card("b")}</div>
            {passBroke && !p && <p className="text-fg-2">{lonePairText(item, spec.carry_over_days)}</p>}
            {/* where day close looked: only for a reason it found by the carry-over window */}
            {!p && !["Duplicate", "Ambiguous", "Unconfirmed suggestion"].includes(item.breakReason ?? "") && <p className="text-fg-2">{carryOverText(item.businessDate, spec.carry_over_days)}</p>}
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
          <DialogDescription>
            {item.status === "break"
              // a suggestion day close broke (re-check 5, B2): what it is now, not what it was
              ? `Break · ${rangeText(item.businessDate, item.businessDate)} · suggested by pass ${g.passNo}, not accepted by day close`
              : [KIND[g.kind] ?? g.kind, rangeText(g.businessDate, g.businessDate), ev.chosen ? CHOSEN[ev.chosen] ?? "" : ""].filter(Boolean).join(" · ")}
          </DialogDescription>
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
