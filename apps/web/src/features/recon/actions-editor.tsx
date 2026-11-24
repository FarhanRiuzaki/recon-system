"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { StatusChip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, EditIcon, RemoveIcon } from "@starterkit/ui/ui/icons";
import type { ConnectorOperationsDto } from "@starterkit/shared/contracts/integrations";
import type { ActionSpec } from "@starterkit/shared/contracts/recon";
import type { CatalogField } from "@starterkit/shared/conditions";
import type { Trigger } from "@starterkit/shared/workflows";
import { api } from "@/lib/client/api";
import { connectorOperationsQuery } from "@/lib/shared/queries-recon";
import { opOf } from "./action-parts";
import { mappingGaps } from "./actions-model";
import { ActionSummary } from "./action-summary";
import { statusTone } from "@/lib/shared/categories";

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
  // what the editor starts from: fixed while it is open (a new object each render would read as a change)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => (open === null ? null : actions[open] ?? blank()), [open]);
  const gapsOf = (a: ActionSpec) => a.variants.flatMap((v) => { const o = opOf(ops, v.operation).op; return o ? mappingGaps(v.mapping, o) : []; });
  return (
    <div className="grid gap-3">
      {actions.length === 0 && (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-body-sm text-fg-3">
          Nothing is sent to the bank on this approval yet. Add an action to post to the bank or notify it.
        </p>
      )}
      <ol className="grid gap-list">
        {actions.map((a, i) => {
          const gaps = opsQ.data ? gapsOf(a) : [];
          return (
            <li key={i} className="flex flex-wrap items-start gap-3 rounded-lg border border-line-strong bg-card px-4 py-3 shadow-xs">
              <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-label text-primary-foreground tabular">{i + 1}</span>
              <div className="min-w-0 flex-1"><ActionSummary action={a} ops={opsQ.data ? ops : undefined} catalog={catalog} setup={setup} /></div>
              {opsQ.data && (gaps.length
                ? <StatusChip health={statusTone("missing")} label={`${gaps.length} required ${gaps.length === 1 ? "field" : "fields"} empty`} />
                : <StatusChip health={statusTone("ready")} label="Every field mapped" />)}
              {!disabled && (
                <span className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="edit" size="sm" onClick={() => setOpen(i)}><Icon icon={EditIcon} />Edit</Button>
                  <Button type="button" variant="remove" size="icon-sm" aria-label={`Remove ${a.name}`} onClick={() => onChange(actions.filter((_, j) => j !== i))}><Icon icon={RemoveIcon} /></Button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {!disabled && actions.length < 10 && (
        <Button type="button" variant="create" size="sm" className="justify-self-start" onClick={() => setOpen(actions.length)}><Icon icon={AddIcon} />Add an action</Button>
      )}
      {open !== null && initial && (
        <ActionScreen open initial={initial} changeLabel={changeLabel} ops={ops} catalog={catalog} setup={setup}
          spaceId={spaceId} configId={configId} versionId={versionId} change={kind} index={open}
          onCancel={() => setOpen(null)}
          onDone={(next) => { onChange(open < actions.length ? actions.map((x, j) => (j === open ? next : x)) : [...actions, next]); setOpen(null); }} />
      )}
    </div>
  );
}
