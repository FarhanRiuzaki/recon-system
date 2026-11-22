"use client";

import { Field } from "@starterkit/ui/ds";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { OperationSpec } from "@starterkit/shared/contracts/integrations";
import { fieldPaths, TIMEOUT_MAX_MS, TIMEOUT_MIN_MS } from "@starterkit/shared/integrations";
import { FieldTree } from "./field-tree";

// One operation of a connector (DEC-053): what it is called, where it goes, its request and response fields, when the
// bank's answer counts as success and which field is the bank's reference.

const toggle = (list: readonly string[], path: string, on: boolean) => (on ? [...new Set([...list, path])] : list.filter((p) => p !== path));

export function OperationEditor({ op, onChange, disabled }: { op: OperationSpec; onChange: (o: OperationSpec) => void; disabled: boolean }) {
  const responsePaths = fieldPaths(op.response).filter((p) => p.split(".").every(Boolean));
  const id = (k: string) => `op-${op.key}-${k}`;
  return (
    <div className="grid gap-section">
      <div className="grid gap-4 md:grid-cols-2">
        <Field id={id("name")} label="Name" required>
          <Input id={id("name")} value={op.name} maxLength={80} disabled={disabled} placeholder="Misc debit credit" onChange={(e) => onChange({ ...op, name: e.target.value })} />
        </Field>
        <Field id={id("key")} label="Key" required help="Lowercase letters, digits and _. Recons pick the operation by its key.">
          <Input id={id("key")} value={op.key} maxLength={40} disabled={disabled} className="font-mono" onChange={(e) => onChange({ ...op, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
        </Field>
        <Field id={id("path")} label="Path" required>
          <span className="flex gap-2">
            <Select aria-label="Method" value={op.method} disabled={disabled} className="w-28" onChange={(e) => onChange({ ...op, method: e.target.value as OperationSpec["method"] })}>
              {(["POST", "GET", "PUT"] as const).map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
            <Input id={id("path")} value={op.path} maxLength={300} disabled={disabled} className="font-mono" placeholder="/openapi/v2.0/misc/debit-credit" onChange={(e) => onChange({ ...op, path: e.target.value })} />
          </span>
        </Field>
        <Field id={id("timeout")} label="Time limit (seconds)" required>
          <Input id={id("timeout")} type="number" min={TIMEOUT_MIN_MS / 1000} max={TIMEOUT_MAX_MS / 1000} value={op.timeoutMs / 1000} disabled={disabled}
            onChange={(e) => onChange({ ...op, timeoutMs: Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(Number(e.target.value) * 1000) || TIMEOUT_MIN_MS)) })} />
        </Field>
      </div>

      <FieldTree title="Request fields" fields={op.request} disabled={disabled} openApi={{ path: op.path, method: op.method, side: "request" }}
        onChange={(request) => onChange({ ...op, request })} masked={op.masked} onMask={(p, on) => onChange({ ...op, masked: toggle(op.masked, p, on) })}
        presets={op.presets} onPreset={(p, v) => { const { [p]: _, ...rest } = op.presets; onChange({ ...op, presets: v ? { ...rest, [p]: v } : rest }); }} />
      <FieldTree title="Response fields" fields={op.response} disabled={disabled} openApi={{ path: op.path, method: op.method, side: "response" }}
        onChange={(response) => onChange({ ...op, response })} masked={op.masked} onMask={(p, on) => onChange({ ...op, masked: toggle(op.masked, p, on) })} />

      <div className="grid gap-3">
        <span className="flex flex-wrap items-center gap-2 text-body-sm text-fg-2">
          Success when
          <Select aria-label="Success field" value={op.success?.field ?? ""} disabled={disabled} className="w-56"
            onChange={(e) => onChange({ ...op, success: e.target.value ? { field: e.target.value, equals: op.success?.equals ?? "00" } : null })}>
            <option value="">any answer the bank gives</option>
            {responsePaths.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          {op.success && (
            <>
              is
              <Input aria-label="Success value" value={op.success.equals} maxLength={40} disabled={disabled} className="w-24 font-mono" onChange={(e) => onChange({ ...op, success: { ...op.success!, equals: e.target.value } })} />
            </>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-body-sm text-fg-2">
          Keep the bank&apos;s reference from
          <Select aria-label="Reference field" value={op.reference ?? ""} disabled={disabled} className="w-56" onChange={(e) => onChange({ ...op, reference: e.target.value || null })}>
            <option value="">no field</option>
            {responsePaths.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </span>
      </div>
    </div>
  );
}
