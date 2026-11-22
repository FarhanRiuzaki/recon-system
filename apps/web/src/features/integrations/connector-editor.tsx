"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Failure, Field, Notice, Panel, Segmented, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { cn } from "@starterkit/ui/lib/cn";
import { formatDateTime } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { CheckIcon, EditIcon, RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { ConnectorDetailDto, ConnectorSpec, ConnectorVersionDto, OperationSpec } from "@starterkit/shared/contracts/integrations";
import { ENVIRONMENT_LABEL, ENVIRONMENTS, type OpField, OPERATIONS_MAX, PROFILE_LABEL, TIMEOUT_DEFAULT_MS } from "@starterkit/shared/integrations";
import { DetailNotFound } from "@/components/detail-not-found";
import { ReviewPanel } from "@/components/review-panel";
import { LoadingShape } from "@/components/route-skeleton";
import { type HeaderAction, PageHeader } from "@/components/shell/page-header";
import { api, errorText, isNotFound, retryUnlessNotFound } from "@/lib/client/api";
import { unsaved } from "@/lib/shared/autosave";
import { connectorDetail, INTEGRATIONS_KEY } from "@/lib/shared/queries";
import { prune, replaceAt } from "./connector-model";
import { EnvironmentCard } from "./environment-card";
import { SpecPasteDialog } from "./spec-paste-dialog";
import { OperationEditor } from "./operation-editor";
import { CONNECTOR_SHAPE } from "./shapes";
import { TryPanel } from "./try-panel";

type Save = { state: "idle" | "saving" | "saved" | "error"; at?: number; error?: string };
type Tab = "environments" | "operations" | "try";
const TABS: readonly { value: Tab; label: string }[] = [{ value: "environments", label: "Environments" }, { value: "operations", label: "Operations" }, { value: "try", label: "Try it" }];
const asTab = (v: string | null): Tab => (v === "operations" || v === "try" ? v : "environments");

/** A field typed but not named yet stays on screen and out of the saved draft (the contract names every field). */
const named = (fs: readonly OpField[]): OpField[] => fs.filter((f) => f.name.trim()).map((f) => (f.children ? { ...f, children: named(f.children) } : f));
const savable = (s: ConnectorSpec): ConnectorSpec => ({ ...s, name: s.name.trim(), operations: s.operations.map((o) => prune({ ...o, request: named(o.request), response: named(o.response) })) });
const newOperation = (n: number): OperationSpec => ({
  key: `operation_${n}`, name: `Operation ${n}`, method: "POST", path: "/", timeoutMs: TIMEOUT_DEFAULT_MS, request: [], response: [], success: null, reference: null, masked: [], presets: {}, auto: {},
});

function TurnOffDialog({ id, onDone, onClose }: { id: string; onDone: (d: ConnectorDetailDto) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (!reason.trim()) { setError("Say why it is turned off."); return; }
    setBusy(true); setError(null);
    try { onDone(await api<ConnectorDetailDto>(`/api/integrations/connectors/${encodeURIComponent(id)}/disable`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) })); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone="top">
        <DialogHeader>
          <DialogTitle>Turn off connector</DialogTitle>
          <DialogDescription>Nothing is sent through it until it is turned on again. Actions that would use it are marked not sent.</DialogDescription>
        </DialogHeader>
        <DialogBody>
        <Field id="off-reason" label="Reason" required error={error}>
          <Textarea id="off-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} placeholder="The bank asked us to stop during their incident" />
        </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={() => void go()} disabled={busy} aria-busy={busy || undefined}>
            {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Turn off connector
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One Open API connector (DEC-053): its environments (address, ids, credentials, Get token), its operations (fields,
 * success, reference, masked and fixed values) and Try it. The live version reads only; an Open API manager starts a
 * draft, edits it (autosaved; the tab and operation in the URL), sends it for approval and another one publishes it.
 */
export function ConnectorEditor({ id }: { id: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const d = connectorDetail(id);
  const q = useQuery({ queryKey: d.key, queryFn: () => api<ConnectorDetailDto>(`/api/integrations/connectors/${encodeURIComponent(id)}`), retry: retryUnlessNotFound });
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const c = q.data;
  const draft = c?.open?.status === "draft" ? c.open : null;
  const editing = !!draft && !!c?.canEdit;
  const [view, setView] = useState<"open" | "live">("open");
  const shown: ConnectorVersionDto | null = c ? (view === "live" ? c.published : c.open ?? c.published) : null;
  const readOnly = !(editing && view === "open");

  const tab = asTab(params.get("tab"));
  // the operation by its place in the list (its key is edited on screen and may repeat while typed)
  const opAt = Number(params.get("op") ?? 0);
  const go = (next: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) if (v === null) sp.delete(k); else sp.set(k, v);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  const [spec, setSpec] = useState<ConnectorSpec | null>(null);
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const source = editing && view === "open" ? `draft:${draft!.id}` : `${shown?.id ?? "none"}:${shown?.updatedAt ?? ""}`;
  if (c && shown && source !== loadedFrom) { setLoadedFrom(source); setSpec(editing && view === "open" ? draft!.spec : shown.spec); }

  const [save, setSave] = useState<Save>({ state: "idle" });
  const [savedBody, setSavedBody] = useState<string | null>(null);
  const body = useMemo(() => (spec ? JSON.stringify({ spec: savable(spec) }) : ""), [spec]);
  const pending = editing && view === "open" && !!spec && unsaved(body, savedBody, JSON.stringify({ spec: draft!.spec }));
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(async () => {
      setSave({ state: "saving" });
      try {
        await api(`/api/integrations/connectors/${encodeURIComponent(id)}/draft`, { method: "PATCH", body });
        setSavedBody(body);
        setSave({ state: "saved", at: Date.now() });
      } catch (e) { setSave({ state: "error", error: errorText(e) }); }
    }, 700);
    return () => clearTimeout(t);
  }, [body, pending, id]);

  const [busy, setBusy] = useState<string | null>(null);
  const [turnOff, setTurnOff] = useState(false);
  const [pasting, setPasting] = useState(false);
  async function run(label: string, path: string, b: object | undefined, done: string): Promise<boolean> {
    setBusy(label);
    try {
      const next = await api<ConnectorDetailDto | null>(`/api/integrations/connectors/${encodeURIComponent(id)}${path}`, { method: "POST", ...(b ? { body: JSON.stringify(b) } : {}) });
      void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
      toast(done);
      if (!next) { router.push("/integrations"); return true; }
      qc.setQueryData(d.key, next);
      setSavedBody(null);
      return true;
    } catch (e) { toast.error(errorText(e)); return false; } finally { setBusy(null); }
  }
  const took = (next: ConnectorDetailDto, done: string) => { qc.setQueryData(d.key, next); void qc.invalidateQueries({ queryKey: INTEGRATIONS_KEY }); toast(done); };

  const list = { href: "/integrations", label: "Open API" };
  if (isNotFound(q.error)) return <DetailNotFound title="Connector" noun="connector" list={list} />;
  if (q.error && !c) return <div className="grid gap-section"><PageHeader title="Connector" /><Panel><Failure title="Couldn't load the connector" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!c || !spec || skeleton) return <LoadingShape sections={CONNECTOR_SHAPE} shown={skeleton} />;

  const status = c.disabled ? { health: "down" as const, label: "Turned off" }
    : !c.open ? c.published ? { health: "healthy" as const, label: `Live · version ${c.published.version}` } : { health: "stopped" as const, label: "Not live" }
      : c.open.status === "draft" ? { health: "unknown" as const, label: `Draft ${c.open.version}` } : { health: "degraded" as const, label: `Version ${c.open.version} waits for approval` };
  const more: HeaderAction[] = [
    ...(draft && c.canEdit ? [{
      label: "Discard draft", destructive: true as const,
      confirm: { title: `Discard draft ${draft.version}`, description: c.published ? "The changes in this draft go. The live version keeps working." : "This connector was never published: it goes with its draft.", actionLabel: "Discard draft", onConfirm: async () => { await run("discard", "/draft/discard", undefined, "Draft discarded."); } },
    }] : []),
    ...(c.canEdit && c.published && !c.disabled ? [{ label: "Turn off connector", onSelect: () => setTurnOff(true) }] : []),
    ...(c.canEdit && c.disabled ? [{ label: "Turn on connector", busy: busy === "on", onSelect: () => void run("on", "/enable", undefined, "Connector turned on.") }] : []),
  ];
  const set = (s: ConnectorSpec) => setSpec(s);
  const at = Number.isInteger(opAt) && opAt >= 0 && opAt < spec.operations.length ? opAt : 0;
  const op = spec.operations[at] ?? null;
  const setOp = (o: OperationSpec) => set({ ...spec, operations: replaceAt(spec.operations, at, o) });

  return (
    <div className="grid gap-section">
      <PageHeader title={(!readOnly && spec.name.trim()) || c.name} description={`${PROFILE_LABEL[spec.profile]} · ${spec.operations.length} ${spec.operations.length === 1 ? "operation" : "operations"}`}
        status={<StatusChip health={status.health} label={status.label} />} more={more.length ? more : undefined}
        actions={!c.open && c.canEdit
          ? <Button type="button" onClick={() => void run("start", "/draft", undefined, "Draft started from the live version.")} disabled={!!busy} aria-busy={busy === "start" || undefined}>
              <Icon icon={busy === "start" ? SpinnerIcon : EditIcon} className={busy === "start" ? "motion-safe:animate-spin" : undefined} />Edit connector
            </Button>
          : draft && c.canEdit
            ? <Button type="button" onClick={() => void run("submit", "/draft/submit", undefined, "Sent for approval.")} disabled={!!busy || pending || save.state === "error"} aria-busy={busy === "submit" || undefined}>
                {busy === "submit" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Send for approval
              </Button>
            : undefined} />

      {c.disabled && <Notice tone="warn">Turned off{c.disabled.by?.name ? ` by ${c.disabled.by.name}` : ""}: {c.disabled.reason}</Notice>}
      {draft?.reviewComment && <Notice tone="warn">Sent back by {draft.decidedBy?.name ?? "a reviewer"}: “{draft.reviewComment}”</Notice>}
      {c.open?.status === "in_review" && (
        <ReviewPanel open={c.open} blocked={c.reviewBlocked} overrideOnly={c.overrideOnly} busy={busy}
          onDecide={(how, b) => run(how, `/review/${how}`, b, how === "approve" ? `Version ${c.open!.version} is live.` : "Sent back to its maker.")} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Section" value={tab} onChange={(t) => go({ tab: t })} options={TABS} />
        <span className="flex flex-wrap items-center gap-3">
          {c.open && c.published && (
            <Segmented label="Version shown" value={view} onChange={setView}
              options={[{ value: "open", label: c.open.status === "draft" ? `Draft ${c.open.version}` : `Version ${c.open.version}` }, { value: "live", label: `Live · ${c.published.version}` }]} />
          )}
          {!readOnly && (
            <span role="status" className="text-caption text-fg-3">
              {save.state === "saving" ? "Saving…" : save.state === "saved"
                ? <span key={save.at} className="inline-flex items-center gap-1 animate-pop"><Icon icon={CheckIcon} className="text-healthy-ink" />Saved {formatDateTime(save.at!)}</span>
                : save.state === "error" ? <span className="text-down-ink">Not saved: {save.error}</span> : "Changes save as you go"}
            </span>
          )}
        </span>
      </div>

      {tab === "environments" && (
        <div className="grid gap-section">
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="cn-name" label="Name" required>
              <Input id="cn-name" value={spec.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ ...spec, name: e.target.value })} />
            </Field>
            <Field id="cn-active" label="Calls go to">
              <Select id="cn-active" value={spec.active} disabled={readOnly} onChange={(e) => set({ ...spec, active: e.target.value as ConnectorSpec["active"] })}>
                {ENVIRONMENTS.map((e) => <option key={e} value={e}>{ENVIRONMENT_LABEL[e]}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid items-start gap-section xl:grid-cols-2">
            {ENVIRONMENTS.map((e) => (
              <EnvironmentCard key={e} c={c} env={e} settings={spec.environments[e]} editing={!readOnly} canEdit={c.canEdit} active={spec.active === e}
                onSettings={(s) => set({ ...spec, environments: { ...spec.environments, [e]: s } })} onDetail={(next) => took(next, "Credential replaced.")} />
            ))}
          </div>
        </div>
      )}

      {tab === "operations" && (
        <div className="grid items-start gap-section xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <Panel title="Operations" count={spec.operations.length}>
            <div className="grid gap-2">
              <ul className="grid gap-1" aria-label="Operations">
                {spec.operations.map((o, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => go({ op: String(i) })} aria-current={i === at ? "true" : undefined}
                      className={cn("grid w-full rounded-md px-3 py-2 text-left transition-colors duration-(--dur-fast) hover:bg-tray focus-visible:outline-2 focus-visible:outline-primary", i === at && "bg-tray")}>
                      <span className="truncate text-body-sm text-fg">{o.name}</span>
                      <span className="truncate font-mono text-caption text-fg-3">{o.method} {o.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {!readOnly && (
                <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={() => setPasting(true)}>Paste a whole spec</Button>
              )}
              {!readOnly && spec.operations.length < OPERATIONS_MAX && (
                <Button type="button" variant="add" size="sm" className="justify-self-start" onClick={() => {
                  let n = spec.operations.length + 1;
                  while (spec.operations.some((o) => o.key === `operation_${n}`)) n++;
                  set({ ...spec, operations: [...spec.operations, newOperation(n)] }); go({ op: String(spec.operations.length) });
                }}>Add operation</Button>
              )}
            </div>
          </Panel>
          {op ? (
            <Panel title={op.name || "Operation"} actions={!readOnly ? <Button type="button" variant="remove" size="icon" aria-label={`Remove ${op.name || "this operation"} from the draft`} onClick={() => { set({ ...spec, operations: spec.operations.filter((_, j) => j !== at) }); go({ op: null }); }}><Icon icon={RemoveIcon} /></Button> : undefined}>
              <OperationEditor key={at} op={op} onChange={setOp} disabled={readOnly} />
            </Panel>
          ) : (
            <Panel title="Operations"><p className="text-body-sm text-fg-3">No operations yet. {readOnly ? "A draft adds them." : "Paste a whole spec to add its operations at once, or add one."}</p></Panel>
          )}
        </div>
      )}

      {tab === "try" && <TryPanel id={c.id} operations={spec.operations} />}
      {pasting && <SpecPasteDialog spec={spec} onClose={() => setPasting(false)} onApply={(next, note) => { setPasting(false); set(next); toast(note); }} />}
      {turnOff && <TurnOffDialog id={c.id} onClose={() => setTurnOff(false)} onDone={(next) => { setTurnOff(false); took(next, "Connector turned off."); }} />}
    </div>
  );
}
