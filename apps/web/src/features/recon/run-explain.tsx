"use client";

import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import type { ReconRunItemDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { amountText, differenceText, evidenceOf, rangeText } from "./run-model";
import { conditionText, type Fields, pairText } from "./spec-model";

const KIND: Record<string, string> = { auto: "Matched", suggested: "Suggested", manual: "Matched by hand", force: "Forced" };

/**
 * Explain (list view, Task 5; the graph follows in Task 7): why a group is a group. Its members on both sides, how the
 * pass found them, and each condition of the pass with what it saw (side B − side A). Loaded on demand (next/dynamic).
 */
export default function RunExplain({ item, spec, fields, labels, onClose }: {
  item: ReconRunItemDto; spec: ReconSpec; fields: Fields; labels: readonly [string, string]; onClose: () => void;
}) {
  const g = item.group!;
  const pass = spec.passes.find((p) => p.no === g.passNo);
  const ev = evidenceOf(g.evidence);
  const ccy = g.members[0]?.currency ?? null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pass {g.passNo}{pass ? ` · ${pass.name}` : ""}</DialogTitle>
          <DialogDescription>{[KIND[g.kind] ?? g.kind, rangeText(g.businessDate, g.businessDate), ev.chosen ? `chosen as ${ev.chosen}` : ""].filter(Boolean).join(" · ")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-body-sm">
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
        <DialogFooter><Button type="button" variant="secondary" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
