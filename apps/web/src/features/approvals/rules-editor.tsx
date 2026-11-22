"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Failure, Notice, Panel, Segmented, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatDateTime } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconRowDto } from "@starterkit/shared/contracts/recon";
import type { BindingSpec, RulesDetailDto, RulesVersionDto } from "@starterkit/shared/contracts/workflows";
import { TRIGGER_LABEL, TRIGGER_TEXT, type Trigger } from "@starterkit/shared/workflows";
import { LoadingShape } from "@/components/route-skeleton";
import { type HeaderAction, PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { APPROVALS_KEY } from "@/lib/shared/queries";
import { approvalRulesDetail } from "@/lib/shared/queries-recon";
import { RULES_EDITOR_SHAPE } from "./shapes";
import { ReviewPanel } from "./review-panel";
import { WhoApproves } from "./who-approves";
import { type KeyedRule, RulesEditor } from "./binding-rules";

const keyed = (s: BindingSpec): KeyedRule[] => s.rules.map((rule) => ({ key: crypto.randomUUID(), rule }));
type Save = { state: "idle" | "saving" | "saved" | "error"; at?: number; error?: string };

/**
 * A space's approval rules for one trigger (DEC-052 revision §4.3): rules that pick library workflows, beside Who
 * approves. The live version reads only; a space admin or workflow manager starts a draft from it, edits it
 * (autosaved), sends it for approval and another one publishes it (or sends it back with a comment; a Superadmin their
 * own only by override, with a reason).
 */
export function ApprovalRulesEditor({ spaceId, trigger }: { spaceId: string; trigger: Trigger }) {
  const qc = useQueryClient();
  const d = approvalRulesDetail(spaceId, trigger);
  const q = useQuery({ queryKey: d.key, queryFn: () => api<RulesDetailDto>(d.url) });
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const recons = useQuery({ queryKey: [...APPROVALS_KEY, "recons-for-rules", spaceId], queryFn: () => api<Page<ReconRowDto>>(`/api/spaces/${encodeURIComponent(spaceId)}/recons?pageSize=100`) });
  const w = q.data;
  const draft = w?.open?.status === "draft" ? w.open : null;
  const editing = !!draft && !!w?.canEdit;
  const [view, setView] = useState<"open" | "live">("open");
  const shown: RulesVersionDto | null = w ? (view === "live" ? w.published : w.open ?? w.published) : null;

  // the rules on screen: the draft's while editing (autosaved), else the version shown
  const [rules, setRules] = useState<KeyedRule[]>([]);
  const [otherwise, setOtherwise] = useState<string | null>(null);
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const source = editing && view === "open" ? `draft:${draft!.id}` : `${shown?.id ?? "none"}:${shown?.updatedAt ?? ""}`;
  if (w && source !== loadedFrom) {
    const from = editing && view === "open" ? draft!.spec : shown?.spec ?? { rules: [], otherwise: null };
    setLoadedFrom(source); setRules(keyed(from)); setOtherwise(from.otherwise);
  }
  const spec = useMemo<BindingSpec>(() => ({ rules: rules.map((x) => x.rule), otherwise }), [rules, otherwise]);
  // a rule with no workflow picked yet can't be saved (the API wants a live workflow per rule)
  const complete = spec.rules.every((r) => r.workflowId && r.name.trim());

  const [save, setSave] = useState<Save>({ state: "idle" });
  // the body the server holds (null = the draft as loaded): nothing is sent until the rules differ from it
  const [savedBody, setSavedBody] = useState<string | null>(null);
  useEffect(() => {
    if (!editing || view !== "open") return;
    const body = JSON.stringify({ spec });
    if (!complete || body === (savedBody ?? JSON.stringify({ spec: draft!.spec }))) return;
    const t = setTimeout(async () => {
      setSave({ state: "saving" });
      try {
        await api(`/api/spaces/${encodeURIComponent(spaceId)}/approval-rules/${trigger}/draft`, { method: "PATCH", body });
        setSavedBody(body);
        setSave({ state: "saved", at: Date.now() });
      } catch (e) { setSave({ state: "error", error: errorText(e) }); }
    }, 700);
    return () => clearTimeout(t);
  }, [spec, complete, editing, view, savedBody]); // eslint-disable-line react-hooks/exhaustive-deps -- the draft id and url follow `editing`

  const [busy, setBusy] = useState<string | null>(null);
  async function run(label: string, path: string, body: object | undefined, done: string): Promise<boolean> {
    setBusy(label);
    try {
      const next = await api<RulesDetailDto>(`/api/spaces/${encodeURIComponent(spaceId)}/approval-rules/${trigger}${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      qc.setQueryData(d.key, next);
      void qc.invalidateQueries({ queryKey: APPROVALS_KEY });
      setSavedBody(null);
      toast(done);
      return true;
    } catch (e) { toast.error(errorText(e)); return false; } finally { setBusy(null); }
  }

  if (q.error && !w) return <div className="grid gap-section"><PageHeader title={`${TRIGGER_LABEL[trigger]} approval rules`} /><Panel><Failure title="Couldn't load the approval rules" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!w || skeleton) return <LoadingShape sections={RULES_EDITOR_SHAPE} shown={skeleton} />;

  const status = !w.open
    ? w.published ? { health: "healthy" as const, label: `Live · version ${w.published.version}` } : { health: "stopped" as const, label: "Default chain" }
    : w.open.status === "draft" ? { health: "unknown" as const, label: `Draft ${w.open.version}` } : { health: "degraded" as const, label: `Version ${w.open.version} waits for approval` };
  const more: HeaderAction[] = draft && w.canEdit ? [{
    label: "Discard draft", destructive: true,
    confirm: { title: `Discard draft ${draft.version}`, description: "The rules you changed in this draft go. The live version keeps routing requests.", actionLabel: "Discard draft", onConfirm: async () => { await run("discard", "/draft/discard", undefined, "Draft discarded."); } },
  }] : [];
  const options = { library: w.library, recons: (recons.data?.items ?? []).map((r) => ({ id: r.id, name: r.name })) };

  return (
    <div className="grid gap-section">
      <PageHeader title={`${TRIGGER_LABEL[trigger]} approval rules`} description={TRIGGER_TEXT[trigger]}
        status={<StatusChip health={status.health} label={status.label} />} more={more.length ? more : undefined}
        actions={!w.open && w.canEdit
          ? <Button type="button" onClick={() => void run("start", "/draft", undefined, "Draft started from the live version.")} disabled={!!busy} aria-busy={busy === "start" || undefined}>
              {busy === "start" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Edit rules
            </Button>
          : draft && w.canEdit
            ? <Button type="button" onClick={() => void run("submit", "/draft/submit", undefined, "Sent for approval.")} disabled={!!busy || save.state === "saving" || !complete} aria-busy={busy === "submit" || undefined}>
                {busy === "submit" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Send for approval
              </Button>
            : undefined} />

      {draft?.reviewComment && <Notice tone="warn">Sent back by {draft.decidedBy?.name ?? "a reviewer"}: “{draft.reviewComment}”</Notice>}
      {w.open?.status === "in_review" && (
        <ReviewPanel open={w.open} blocked={w.reviewBlocked} overrideOnly={w.overrideOnly} busy={busy}
          onDecide={(how, body) => run(how, `/review/${how}`, body, how === "approve" ? `Version ${w.open!.version} is live.` : "Sent back to its maker.")} />
      )}

      <div className="grid items-start gap-section xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {w.open && w.published ? (
              <Segmented label="Version shown" value={view} onChange={setView}
                options={[{ value: "open", label: w.open.status === "draft" ? `Draft ${w.open.version}` : `Version ${w.open.version}` }, { value: "live", label: `Live · ${w.published.version}` }]} />
            ) : <span className="text-body-sm text-fg-2">Rules are checked top to bottom; the first that matches picks the workflow.</span>}
            {editing && view === "open" && (
              <span role="status" className="text-caption text-fg-3">
                {save.state === "saving" ? "Saving…" : save.state === "saved" ? `Saved ${formatDateTime(save.at!)}` : save.state === "error" ? <span className="text-down-ink">Not saved: {save.error}</span> : "Changes save as you go"}
              </span>
            )}
          </div>
          {editing && view === "open" && !w.library.length && <Notice>No workflow is live yet. A workflow manager publishes one in Workflows; until then every request takes the default chain.</Notice>}
          {editing && view === "open" && !complete && <span role="status" className="text-caption text-down-ink">Name every rule and pick its workflow to save.</span>}
          <RulesEditor rules={rules} onChange={setRules} otherwise={otherwise} onOtherwise={setOtherwise} options={options} disabled={!(editing && view === "open")} />
        </div>
        <div className="min-w-0 xl:sticky xl:top-(--topbar-h)">
          <WhoApproves spaceId={spaceId} trigger={trigger} spec={complete ? spec : null} recons={options.recons} />
        </div>
      </div>
    </div>
  );
}
