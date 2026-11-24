"use client";

import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { Ops } from "./actions-model";
import type { ActionSpec, VariantSpec } from "@starterkit/shared/contracts/recon";

// The pickers an action is set up with, shared by the Approval step's cards and the full-screen action editor.

export { type Ops, opOf } from "./actions-model";

/** Connector, version (published once) and operation, as one select each. */
export function OperationPicker({ value, onChange, ops, label, stacked }: { value: VariantSpec["operation"] | null; onChange: (v: VariantSpec["operation"]) => void; ops: Ops; label: string; stacked?: boolean }) {
  const c = ops.find((x) => x.id === value?.connectorId);
  const v = c?.versions.find((x) => x.version === value?.version);
  const live = (cc: Ops[number]) => cc.versions.find((x) => x.live) ?? cc.versions[0]!;
  return (
    <span className={stacked ? "grid min-w-0 grid-cols-1 gap-2 [&>*]:w-full [&>*]:min-w-0" : "grid gap-2 md:grid-cols-3"}>
      <Select aria-label={`${label}: connector`} value={c?.id ?? ""} onChange={(e) => { const cc = ops.find((x) => x.id === e.target.value); if (cc) onChange({ connectorId: cc.id, version: live(cc).version, key: live(cc).operations[0]?.key ?? "" }); }}>
        {!c && <option value="">Pick a connector</option>}
        {ops.map((x) => <option key={x.id} value={x.id}>{x.name}{x.disabled ? " (turned off)" : ""}</option>)}
      </Select>
      <Select aria-label={`${label}: version`} value={v?.version ?? ""} disabled={!c} onChange={(e) => { const vv = c?.versions.find((x) => x.version === Number(e.target.value)); if (c && vv) onChange({ connectorId: c.id, version: vv.version, key: vv.operations.find((o) => o.key === value?.key)?.key ?? vv.operations[0]?.key ?? "" }); }}>
        {c?.versions.map((x) => <option key={x.version} value={x.version}>Version {x.version}{x.live ? " (live)" : ""}</option>)}
      </Select>
      <Select aria-label={`${label}: operation`} value={value?.key ?? ""} disabled={!v} onChange={(e) => c && v && onChange({ connectorId: c.id, version: v.version, key: e.target.value })}>
        {v?.operations.map((o) => <option key={o.key} value={o.key}>{o.name} · {o.method} {o.path}</option>)}
      </Select>
    </span>
  );
}

const EVENTS = [{ value: "approved", label: "When the change is approved" }, { value: "level_approved", label: "When a level approves" }, { value: "rejected", label: "When the change is rejected" }] as const;
export function EventPicker({ value, onChange, label }: { value: ActionSpec["on"]; onChange: (v: ActionSpec["on"]) => void; label: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Select aria-label={`${label}: when`} value={value.event} className="min-w-0 flex-1" onChange={(e) => onChange(e.target.value === "level_approved" ? { event: "level_approved", level: 1 } : { event: e.target.value as "approved" | "rejected" })}>
        {EVENTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
      </Select>
      {value.event === "level_approved" && (
        <Input aria-label={`${label}: level`} type="number" min={1} max={10} value={value.level} className="w-20" onChange={(e) => onChange({ event: "level_approved", level: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} />
      )}
    </span>
  );
}

