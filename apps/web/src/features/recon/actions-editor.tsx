"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useState } from "react";
import { StatusChip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, RemoveIcon } from "@starterkit/ui/ui/icons";
import type { ConnectorOperationsDto } from "@starterkit/shared/contracts/integrations";
import type { ActionSpec } from "@starterkit/shared/contracts/recon";
import { type CatalogField, type Condition, conditionText } from "@starterkit/shared/conditions";
import type { Trigger } from "@starterkit/shared/workflows";
import { api } from "@/lib/client/api";
import { connectorOperationsQuery } from "@/lib/shared/queries-recon";
import { opOf } from "./action-parts";
import { actionSentence, mappingGaps } from "./actions-model";

// A change's actions in the Approval step (stage 4, design §4.4–4.5): a card per action ("When the change is approved,
// post Post to GL"), its variants and whether every required field is mapped; Edit opens it in the full-screen editor
// (action-screen.tsx, loaded on demand), Add an action opens a new one there. Nothing reaches the draft before Done.

const ActionScreen = dynamic(() => import("./action-screen").then((m) => m.ActionScreen), { ssr: false });
type Setup = { accounts: readonly { key: string; label: string; number: string; currency: string }[]; lookups: readonly { name: string }[] };
const blank = (): ActionSpec => ({
  name: "", kind: "posting", on: { event: "approved" },
  variants: [{ name: "Default", when: null, operation: { connectorId: "", version: 1, key: "" }, mapping: {}, per: "item", zeroOrNegative: "skip" }],
} as ActionSpec);

export function ActionsEditor({ kind, changeLabel, actions, onChange, spaceId, configId, versionId, catalog, setup, disabled }: {
  kind: Trigger; changeLabel: string; actions: readonly ActionSpec[]; onChange: (a: ActionSpec[]) => void; spaceId: string; configId: string; versionId: string;
  catalog: readonly CatalogField[]; setup: Setup; disabled: boolean;
}) {
  const q = connectorOperationsQuery(spaceId);
  const opsQ = useQuery({ queryKey: q.key, queryFn: () => api<ConnectorOperationsDto>(q.url) });
  const ops = opsQ.data?.items ?? [];
  // the action open in the editor: its index (actions.length = a new one)
  const [open, setOpen] = useState<number | null>(null);
  const gapsOf = (a: ActionSpec) => a.variants.flatMap((v) => { const o = opOf(ops, v.operation).op; return o ? mappingGaps(v.mapping, o) : []; });
  return (
    <div className="grid gap-3">
      {actions.length === 0 && (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-body-sm text-fg-3">
          Nothing is sent to the bank on this approval yet. Add an action to post to the bank or notify it.
        </p>
      )}
      <ol className="grid gap-2">
        {actions.map((a, i) => {
          const gaps = opsQ.data ? gapsOf(a) : [];
          return (
            <li key={i} className="flex flex-wrap items-center gap-3 rounded-lg border border-line-strong bg-card px-4 py-3 shadow-xs">
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-primary-soft text-label text-primary tabular">{i + 1}</span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-body text-fg">{actionSentence(a)}</span>
                <span className="truncate text-caption text-fg-3">
                  {a.variants.map((v) => `${v.name}: ${v.when ? conditionText(v.when as Condition, catalog) : "every break"} → ${opOf(ops, v.operation).op?.name ?? (v.operation.key || "nowhere yet")}`).join(" · ")}
                </span>
              </span>
              {opsQ.data && (gaps.length
                ? <StatusChip health="down" label={`${gaps.length} required ${gaps.length === 1 ? "field" : "fields"} empty`} />
                : <StatusChip health="healthy" label="Every field mapped" />)}
              {!disabled && (
                <span className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(i)}>Edit</Button>
                  <Button type="button" variant="remove" size="icon" aria-label={`Remove ${a.name}`} onClick={() => onChange(actions.filter((_, j) => j !== i))}><Icon icon={RemoveIcon} /></Button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {!disabled && actions.length < 10 && (
        <Button type="button" variant="add" className="justify-self-start" onClick={() => setOpen(actions.length)}><Icon icon={AddIcon} />Add an action</Button>
      )}
      {open !== null && (
        <ActionScreen open initial={actions[open] ?? blank()} changeLabel={changeLabel} ops={ops} catalog={catalog} setup={setup}
          spaceId={spaceId} configId={configId} versionId={versionId} change={kind} index={open}
          onCancel={() => setOpen(null)}
          onDone={(next) => { onChange(open < actions.length ? actions.map((x, j) => (j === open ? next : x)) : [...actions, next]); setOpen(null); }} />
      )}
    </div>
  );
}
