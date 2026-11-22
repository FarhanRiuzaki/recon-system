"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Failure, Field, Notice, Panel, Segmented, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatDateTime } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconRowDto } from "@starterkit/shared/contracts/recon";
import type { SpaceMemberDto } from "@starterkit/shared/contracts/spaces";
import type { WorkflowDetailDto, WorkflowSpec, WorkflowVersionDto } from "@starterkit/shared/contracts/workflows";
import { WORKFLOW_ACTION_LABEL, WORKFLOW_ACTION_TEXT, type WorkflowAction } from "@starterkit/shared/workflows";
import { LoadingShape } from "@/components/route-skeleton";
import { type HeaderAction, PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { APPROVALS_KEY, SPACES_KEY } from "@/lib/shared/queries";
import { workflowDetail } from "@/lib/shared/queries-recon";
import { WORKFLOW_SHAPE } from "./shapes";
import { WhoApproves } from "./who-approves";
import { type KeyedRule, RulesEditor } from "./workflow-rules";

const keyed = (s: WorkflowSpec): KeyedRule[] => s.rules.map((rule) => ({ key: crypto.randomUUID(), rule }));
const specOf = (r: KeyedRule[]): WorkflowSpec => ({ rules: r.map((x) => x.rule) });
type Save = { state: "idle" | "saving" | "saved" | "error"; at?: number; error?: string };

/**
 * One approval workflow of a space (DEC-052): its rules beside Who approves. The live version reads only; a space admin
 * or workflow manager starts a draft from it, edits it (autosaved), sends it for approval and another one publishes it
 * (or sends it back with a comment; a Superadmin their own only by override, with a reason).
 */
export function WorkflowEditor({ spaceId, action }: { spaceId: string; action: WorkflowAction }) {
  const qc = useQueryClient();
  const d = workflowDetail(spaceId, action);
  const q = useQuery({ queryKey: d.key, queryFn: () => api<WorkflowDetailDto>(d.url) });
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const members = useQuery({ queryKey: [...SPACES_KEY, "members-for-workflows", spaceId], queryFn: () => api<Page<SpaceMemberDto>>(`/api/spaces/${encodeURIComponent(spaceId)}/members?pageSize=100`) });
  const recons = useQuery({ queryKey: [...APPROVALS_KEY, "recons-for-workflows", spaceId], queryFn: () => api<Page<ReconRowDto>>(`/api/spaces/${encodeURIComponent(spaceId)}/recons?pageSize=100`) });
  const w = q.data;
  const draft = w?.open?.status === "draft" ? w.open : null;
  const editing = !!draft && !!w?.canEdit;
  const [view, setView] = useState<"open" | "live">("open");
  const shown: WorkflowVersionDto | null = w ? (view === "live" ? w.published : w.open ?? w.published) : null;

  // the rules on screen: the draft's while editing (autosaved), else the version shown
  const [rules, setRules] = useState<KeyedRule[]>([]);
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const source = editing && view === "open" ? `draft:${draft!.id}` : `${shown?.id ?? "none"}:${shown?.updatedAt ?? ""}`;
  if (w && source !== loadedFrom) { setLoadedFrom(source); setRules(keyed(editing && view === "open" ? draft!.spec : shown?.spec ?? { rules: [] })); }
  const spec = useMemo(() => specOf(rules), [rules]);

  const [save, setSave] = useState<Save>({ state: "idle" });
  // the body the server holds (null = the draft as loaded): nothing is sent until the rules differ from it
  const [savedBody, setSavedBody] = useState<string | null>(null);
  useEffect(() => {
    if (!editing || view !== "open") return;
    const body = JSON.stringify({ spec });
    if (body === (savedBody ?? JSON.stringify({ spec: draft!.spec }))) return;
    const t = setTimeout(async () => {
      setSave({ state: "saving" });
      try {
        await api(`/api/spaces/${encodeURIComponent(spaceId)}/workflows/${action}/draft`, { method: "PATCH", body });
        setSavedBody(body);
        setSave({ state: "saved", at: Date.now() });
      } catch (e) { setSave({ state: "error", error: errorText(e) }); }
    }, 700);
    return () => clearTimeout(t);
  }, [spec, editing, view, savedBody]); // eslint-disable-line react-hooks/exhaustive-deps -- the draft id and url follow `editing`

  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  async function run(label: string, path: string, body: object | undefined, done: string) {
    setBusy(label);
    try {
      const next = await api<WorkflowDetailDto>(`/api/spaces/${encodeURIComponent(spaceId)}/workflows/${action}${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      qc.setQueryData(d.key, next);
      void qc.invalidateQueries({ queryKey: APPROVALS_KEY });
      setSavedBody(null);
      setComment("");
      toast(done);
    } catch (e) { toast.error(errorText(e)); } finally { setBusy(null); }
  }

  if (q.error && !w) return <div className="grid gap-section"><PageHeader title={`${WORKFLOW_ACTION_LABEL[action]} workflow`} /><Panel><Failure title="Couldn't load the workflow" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!w || skeleton) return <LoadingShape sections={WORKFLOW_SHAPE} shown={skeleton} />;

  const status = !w.open
    ? w.published ? { health: "healthy" as const, label: `Live · version ${w.published.version}` } : { health: "stopped" as const, label: "Default chain" }
    : w.open.status === "draft" ? { health: "unknown" as const, label: `Draft ${w.open.version}` } : { health: "degraded" as const, label: `Version ${w.open.version} waits for approval` };
  const more: HeaderAction[] = draft && w.canEdit ? [{
    label: "Discard draft", destructive: true,
    confirm: { title: `Discard draft ${draft.version}`, description: "The rules you changed in this draft go. The live version keeps routing requests.", actionLabel: "Discard draft", onConfirm: () => run("discard", "/draft/discard", undefined, "Draft discarded.") },
  }] : [];
  const people = (members.data?.items ?? []).filter((m) => m.active).map((m) => ({ id: m.userId, name: m.name }));
  const options = { people: [...people, ...w.people.filter((p) => !people.some((x) => x.id === p.id)).map((p) => ({ id: p.id, name: p.name ?? "A removed user" }))], globalRoles: w.globalRoles, recons: (recons.data?.items ?? []).map((r) => ({ id: r.id, name: r.name })) };

  return (
    <div className="grid gap-section">
      <PageHeader title={`${WORKFLOW_ACTION_LABEL[action]} workflow`} description={WORKFLOW_ACTION_TEXT[action]}
        status={<StatusChip health={status.health} label={status.label} />} more={more.length ? more : undefined}
        actions={!w.open && w.canEdit
          ? <Button type="button" onClick={() => void run("start", "/draft", undefined, "Draft started from the live version.")} disabled={!!busy} aria-busy={busy === "start" || undefined}>
              {busy === "start" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Edit workflow
            </Button>
          : draft && w.canEdit
            ? <Button type="button" onClick={() => void run("submit", "/draft/submit", undefined, "Sent for approval.")} disabled={!!busy || save.state === "saving" || !rules.every((r) => r.rule.name.trim())} aria-busy={busy === "submit" || undefined}>
                {busy === "submit" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Send for approval
              </Button>
            : undefined} />

      {draft?.reviewComment && <Notice tone="warn">Sent back by {draft.decidedBy?.name ?? "a reviewer"}: “{draft.reviewComment}”</Notice>}
      {w.open?.status === "in_review" && (
        <Panel title={`Version ${w.open.version} waits for approval`} description={`Sent by ${w.open.submittedBy?.name ?? "a removed user"}${w.open.submittedAt ? ` · ${formatDateTime(Date.parse(w.open.submittedAt))}` : ""}`}>
          {w.reviewBlocked ? <p className="text-body-sm text-fg-3">{w.reviewBlocked}</p> : (
            <div className="grid gap-3 md:max-w-xl">
              <Field id="wf-comment" label={w.overrideOnly ? "Reason for the override" : "Comment (optional to publish, required to send back)"} required={w.overrideOnly}>
                <Textarea id="wf-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={w.overrideOnly ? "Why you publish your own version" : "What you checked"} />
              </Field>
              {w.overrideOnly && <Notice>You made this version. As Superadmin you can publish it only by override, with a reason; it is recorded.</Notice>}
              <span className="flex flex-wrap gap-2">
                <Button type="button" disabled={!!busy || (w.overrideOnly && !comment.trim())} aria-busy={busy === "approve" || undefined}
                  onClick={() => void run("approve", "/review/approve", { comment: comment.trim() || undefined, ...(w.overrideOnly ? { override: true } : {}) }, `Version ${w.open!.version} is live.`)}>
                  {busy === "approve" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{w.overrideOnly ? "Publish by override" : "Publish version"}
                </Button>
                {!w.overrideOnly && (
                  <Button type="button" variant="secondary" disabled={!!busy || !comment.trim()} aria-busy={busy === "reject" || undefined}
                    onClick={() => void run("reject", "/review/reject", { comment: comment.trim() }, "Sent back to its maker.")}>Send back</Button>
                )}
              </span>
            </div>
          )}
        </Panel>
      )}

      <div className="grid items-start gap-section xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {w.open && w.published ? (
              <Segmented label="Version shown" value={view} onChange={setView}
                options={[{ value: "open", label: w.open.status === "draft" ? `Draft ${w.open.version}` : `Version ${w.open.version}` }, { value: "live", label: `Live · ${w.published.version}` }]} />
            ) : <span className="text-body-sm text-fg-2">Rules are checked top to bottom; the first that matches decides the chain.</span>}
            {editing && view === "open" && (
              <span role="status" className="text-caption text-fg-3">
                {save.state === "saving" ? "Saving…" : save.state === "saved" ? `Saved ${formatDateTime(save.at!)}` : save.state === "error" ? <span className="text-down-ink">Not saved: {save.error}</span> : "Changes save as you go"}
              </span>
            )}
          </div>
          <RulesEditor rules={rules} onChange={setRules} options={options} disabled={!(editing && view === "open")} />
        </div>
        <div className="min-w-0 xl:sticky xl:top-(--topbar-h)">
          <WhoApproves spaceId={spaceId} action={action} spec={spec} recons={options.recons} />
        </div>
      </div>
    </div>
  );
}
