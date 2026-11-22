"use client";

import { useState } from "react";
import { Field, Panel, ScrollFade, StatusChip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import type { OperationSpec, TryDto } from "@starterkit/shared/contracts/integrations";
import type { OpField } from "@starterkit/shared/integrations";
import { api, errorText } from "@/lib/client/api";

// Try it (DEC-053): one call of an operation to the development environment, with a body typed here; the answer comes
// back decrypted and masked. Production is never called from here.

/** A body to start from: every request field the system doesn't fill (fixed or auto), empty. */
function sampleOf(fields: readonly OpField[], skip: ReadonlySet<string>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const path = `${prefix}${f.name}`;
    if (!f.name || skip.has(path)) continue;
    out[f.name] = f.type === "object" ? sampleOf(f.children ?? [], skip, `${path}.`) : f.type === "array" ? [sampleOf(f.children ?? [], skip, `${path}.`)]
      : f.type === "numeric" ? 0 : f.type === "boolean" ? false : "";
  }
  return out;
}
const OUTCOME = {
  ok: { health: "healthy", label: "Answered" }, rejected: { health: "down", label: "Refused" }, not_sent: { health: "stopped", label: "Not sent" }, timeout: { health: "degraded", label: "No readable answer" },
} as const;

export function TryPanel({ id, operations }: { id: string; operations: readonly OperationSpec[] }) {
  const [key, setKey] = useState(operations[0]?.key ?? "");
  const op = operations.find((o) => o.key === key);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const auto = op?.auto ?? {};
  const body = bodies[key] ?? (op ? JSON.stringify(sampleOf(op.request, new Set([...Object.keys(op.presets), ...Object.keys(auto)])), null, 2) : "{}");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TryDto | { error: string } | null>(null);
  async function send() {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { setRes({ error: "The body isn't JSON. Fix it, then send." }); return; }
    setBusy(true); setRes(null);
    try {
      setRes(await api<TryDto>(`/api/integrations/connectors/${encodeURIComponent(id)}/try`, { method: "POST", body: JSON.stringify({ operation: key, body: parsed }) }));
    } catch (e) { setRes({ error: errorText(e) }); } finally { setBusy(false); }
  }
  if (!operations.length) return <Panel title="Try it"><p className="text-body-sm text-fg-3">Add an operation first, then try it here against the development environment.</p></Panel>;
  return (
    <Panel title="Try it" description="One call to the development environment; production is never called from here">
      <div className="grid gap-4">
        <Field id="try-op" label="Operation">
          <Select id="try-op" value={key} onChange={(e) => { setKey(e.target.value); setRes(null); }}>
            {operations.map((o) => <option key={o.key} value={o.key}>{o.name} · {o.method} {o.path}</option>)}
          </Select>
        </Field>
        <Field id="try-body" label="Body (JSON)" help="Fixed values fill what the body leaves out; auto generated values are filled by the system on every call.">
          <Textarea id="try-body" rows={10} className="font-mono" value={body} onChange={(e) => setBodies({ ...bodies, [key]: e.target.value })} />
        </Field>
        {Object.keys(auto).length > 0 && (
          <div className="grid gap-1">
            <span className="text-label text-fg">Auto generated</span>
            <ul className="flex flex-wrap gap-1.5" aria-label="Fields the system fills">
              {Object.entries(auto).map(([path, a]) => (
                <li key={path} className="rounded-sm bg-tray px-1.5 py-0.5 text-caption text-fg-2">
                  <span className="font-mono text-fg">{path}</span> · {a.kind === "external_id" ? "message ID" : `date and time (${a.format})`}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button type="button" variant="secondary" className="justify-self-start" onClick={() => void send()} disabled={busy || !op} aria-busy={busy || undefined}>
          {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Send to development
        </Button>
        <div role="status" className="grid gap-3">
          {res && "error" in res && <span className="text-body-sm text-down-ink">{res.error}</span>}
          {res && "outcome" in res && (
            <div className="grid gap-3 motion-safe:animate-enter">
              <div className="flex flex-wrap items-center gap-3">
                <StatusChip health={OUTCOME[res.outcome].health} label={OUTCOME[res.outcome].label} />
                {res.success !== null && <StatusChip health={res.success ? "healthy" : "down"} label={res.success ? "Success" : "Not success"} />}
                <span className="text-body-sm text-fg">{res.message}</span>
              </div>
              <dl className="flex flex-wrap gap-x-8 gap-y-2">
                {([["HTTP status", res.status ?? "—"], ["External ID", res.externalId ?? "—"], ["Reference", res.reference ?? "—"], ["Time", `${res.ms} ms`]] as const).map(([k, v]) => (
                  <div key={k} className="grid gap-0.5"><dt className="text-caption text-fg-3">{k}</dt><dd className="font-mono text-body-sm text-fg">{v}</dd></div>
                ))}
              </dl>
              {Object.keys(res.filled).length > 0 && (
                <dl className="flex flex-wrap gap-x-8 gap-y-2" aria-label="Filled by the system">
                  {Object.entries(res.filled).map(([k, v]) => (
                    <div key={k} className="grid gap-0.5"><dt className="font-mono text-caption text-fg-3">{k} · auto</dt><dd className="font-mono text-body-sm text-fg">{v}</dd></div>
                  ))}
                </dl>
              )}
              {(res.response !== null || res.raw) && (
                <ScrollFade className="max-h-96 rounded-lg border border-line bg-tray" tabIndex={0} aria-label="The bank's answer">
                  <pre className="p-3 font-mono text-caption text-fg">{res.response !== null ? JSON.stringify(res.response, null, 2) : res.raw}</pre>
                </ScrollFade>
              )}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
