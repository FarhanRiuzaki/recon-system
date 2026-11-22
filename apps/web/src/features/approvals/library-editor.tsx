"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Failure, Field, Notice, Panel, Segmented, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatDateTime } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { toast } from "@starterkit/ui/ui/toast";
import { BRAND } from "@starterkit/shared/brand";
import type { Page } from "@starterkit/shared/contracts/common";
import type { UserRowDto } from "@starterkit/shared/contracts/users";
import type { ChainSpec, ChainVersionDto, LibraryDetailDto } from "@starterkit/shared/contracts/workflows";
import { RULE_NAME_MAX, type Level } from "@starterkit/shared/workflows";
import { LoadingShape } from "@/components/route-skeleton";
import { type HeaderAction, PageHeader } from "@/components/shell/page-header";
import { DetailNotFound } from "@/components/detail-not-found";
import { api, errorText, isNotFound, retryUnlessNotFound } from "@/lib/client/api";
import { APPROVALS_KEY } from "@/lib/shared/queries";
import { libraryWorkflow } from "@/lib/shared/queries-recon";
import { Levels } from "./levels-editor";
import { ReviewPanel } from "./review-panel";
import { LIBRARY_EDITOR_SHAPE } from "./shapes";
import { UsedBy } from "./used-by";

type Save = { state: "idle" | "saving" | "saved" | "error"; at?: number; error?: string };

/**
 * One library workflow (DEC-052 revision §4.2, §5): its name and levels beside Used by. The live version reads only; a
 * workflow manager starts a draft from it, edits it (autosaved), sends it for approval and another one publishes it
 * (a Superadmin their own only by override, with a reason). Used by shows which spaces' approval rules a publish moves
 * and where a level would lack people.
 */
export function LibraryEditor({ id }: { id: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const d = libraryWorkflow(id);
  const q = useQuery({ queryKey: d.key, queryFn: () => api<LibraryDetailDto>(d.url), retry: retryUnlessNotFound });
  const skeleton = useDelayedFlag(!q.data && !q.error);
  // people a group may name: the first 100 active users (a workflow manager usually reads users), plus those named already
  const users = useQuery({ queryKey: [...APPROVALS_KEY, "people-for-workflows"], queryFn: () => api<Page<UserRowDto>>("/api/users?pageSize=100&status=active"), retry: false });
  const w = q.data;
  const draft = w?.open?.status === "draft" ? w.open : null;
  const editing = !!draft && !!w?.canEdit;
  const [view, setView] = useState<"open" | "live">("open");
  const shown: ChainVersionDto | null = w ? (view === "live" ? w.published : w.open ?? w.published) : null;

  const [name, setName] = useState("");
  const [levels, setLevels] = useState<Level[]>([]);
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const source = editing && view === "open" ? `draft:${draft!.id}` : `${shown?.id ?? "none"}:${shown?.updatedAt ?? ""}`;
  if (w && source !== loadedFrom) {
    const from = editing && view === "open" ? draft!.spec : shown?.spec ?? { name: w.name, levels: [] };
    setLoadedFrom(source); setName(from.name); setLevels(from.levels);
  }
  const spec = useMemo<ChainSpec>(() => ({ name, levels }), [name, levels]);
  const complete = !!name.trim() && levels.length > 0 && levels.every((l) => l.groups.every((g) => g.spaceRoles.length + g.globalRoles.length + g.users.length > 0));

  const [save, setSave] = useState<Save>({ state: "idle" });
  const [savedBody, setSavedBody] = useState<string | null>(null);
  useEffect(() => {
    if (!editing || view !== "open") return;
    const body = JSON.stringify({ spec: { ...spec, name: spec.name.trim() } });
    if (!complete || body === (savedBody ?? JSON.stringify({ spec: draft!.spec }))) return;
    const t = setTimeout(async () => {
      setSave({ state: "saving" });
      try {
        await api(`/api/workflows/${encodeURIComponent(id)}/draft`, { method: "PATCH", body });
        setSavedBody(body);
        setSave({ state: "saved", at: Date.now() });
        void qc.invalidateQueries({ predicate: (x) => JSON.stringify(x.queryKey).includes("/used-by") });
      } catch (e) { setSave({ state: "error", error: errorText(e) }); }
    }, 700);
    return () => clearTimeout(t);
  }, [spec, complete, editing, view, savedBody]); // eslint-disable-line react-hooks/exhaustive-deps -- the draft and url follow `editing` and `id`

  const [busy, setBusy] = useState<string | null>(null);
  async function run(label: string, path: string, body: object | undefined, done: string): Promise<boolean> {
    setBusy(label);
    try {
      const next = await api<LibraryDetailDto | null>(`/api/workflows/${encodeURIComponent(id)}${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      void qc.invalidateQueries({ queryKey: APPROVALS_KEY });
      toast(done);
      if (!next) { router.push("/workflows"); return true; } // a never-published workflow went with its draft
      qc.setQueryData(d.key, next);
      setSavedBody(null);
      return true;
    } catch (e) { toast.error(errorText(e)); return false; } finally { setBusy(null); }
  }

  if (isNotFound(q.error)) return <DetailNotFound title="Workflow" noun="workflow" list={{ href: "/workflows", label: "Workflows" }} />;
  if (q.error && !w) return <div className="grid gap-section"><PageHeader title="Workflow" /><Panel><Failure title="Couldn't load the workflow" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel></div>;
  if (!w || skeleton) return <LoadingShape sections={LIBRARY_EDITOR_SHAPE} shown={skeleton} />;

  const status = w.archived ? { health: "stopped" as const, label: "Archived" }
    : !w.open ? w.published ? { health: "healthy" as const, label: `Live · version ${w.published.version}` } : { health: "stopped" as const, label: "Not live" }
      : w.open.status === "draft" ? { health: "unknown" as const, label: `Draft ${w.open.version}` } : { health: "degraded" as const, label: `Version ${w.open.version} waits for approval` };
  const more: HeaderAction[] = [
    ...(draft && w.canEdit ? [{
      label: "Discard draft", destructive: true as const,
      confirm: { title: `Discard draft ${draft.version}`, description: w.published ? "The changes in this draft go. The live version keeps approving requests." : "This workflow was never published: it goes with its draft.", actionLabel: "Discard draft", onConfirm: async () => { await run("discard", "/draft/discard", undefined, "Draft discarded."); } },
    }] : []),
    ...(w.canEdit && w.published && !w.archived ? [{
      label: "Archive workflow", destructive: true as const,
      confirm: { title: `Archive ${w.name}`, description: "Approval rules can no longer pick it. It is refused while any space's rules still use it.", actionLabel: "Archive workflow", onConfirm: async () => { await run("archive", "/archive", undefined, "Workflow archived."); } },
    }] : []),
  ];
  const named = new Map(w.people.map((p) => [p.id, p.name ?? "A removed user"]));
  for (const u of users.data?.items ?? []) named.set(u.id, u.name);
  const options = { people: [...named].map(([pid, pname]) => ({ id: pid, name: pname })), globalRoles: w.globalRoles };
  const readOnly = !(editing && view === "open");

  return (
    <div className="grid gap-section">
      <PageHeader title={(!readOnly && name.trim()) || w.name} description="An approval chain, level by level. Spaces' approval rules pick it."
        status={<StatusChip health={status.health} label={status.label} />} more={more.length ? more : undefined}
        actions={!w.open && w.canEdit && !w.archived
          ? <Button type="button" onClick={() => void run("start", "/draft", undefined, "Draft started from the live version.")} disabled={!!busy} aria-busy={busy === "start" || undefined}>
              {busy === "start" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Edit workflow
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

      <div className="grid items-start gap-section xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="grid min-w-0 gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {w.open && w.published ? (
              <Segmented label="Version shown" value={view} onChange={setView}
                options={[{ value: "open", label: w.open.status === "draft" ? `Draft ${w.open.version}` : `Version ${w.open.version}` }, { value: "live", label: `Live · ${w.published.version}` }]} />
            ) : <span className="text-body-sm text-fg-2">Levels approve in order; every group in a level must approve.</span>}
            {!readOnly && (
              <span role="status" className="text-caption text-fg-3">
                {save.state === "saving" ? "Saving…" : save.state === "saved" ? `Saved ${formatDateTime(save.at!)}` : save.state === "error" ? <span className="text-down-ink">Not saved: {save.error}</span> : "Changes save as you go"}
              </span>
            )}
          </div>
          <Field id="wf-name" label="Name" required>
            <Input id="wf-name" value={name} maxLength={RULE_NAME_MAX} disabled={readOnly} onChange={(e) => setName(e.target.value)} placeholder="Treasury head" className="md:max-w-md" />
          </Field>
          {!readOnly && !complete && <span role="status" className="text-caption text-down-ink">Name the workflow and pick who approves every group to save.</span>}
          <Levels levels={levels} onChange={setLevels} options={options} disabled={readOnly} />
        </div>
        <div className="min-w-0 xl:sticky xl:top-(--topbar-h)">
          <UsedBy id={id} />
        </div>
      </div>
    </div>
  );
}
