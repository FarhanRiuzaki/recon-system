"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BlockedButton, Failure, Field, Notice, Panel, Segmented, StatusChip } from "@starterkit/ui/ds";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { formatTime } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { CheckIcon, EditIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
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
import { spaceWorkflow } from "@/lib/shared/queries-recon";
import { emptyGroups, Levels } from "./levels-editor";
import { unsaved } from "@/lib/shared/autosave";
import { ReviewPanel } from "@/components/review-panel";
import { LIBRARY_EDITOR_SHAPE } from "./shapes";
import { UsedBy } from "./used-by";

type Save = { state: "idle" | "saving" | "saved" | "error"; at?: number; error?: string };

/**
 * One workflow of a space (DEC-052 rev 2 §4.1, §5; Figma 06 direction A): its name and chain beside Used by. The live
 * version reads only; a space admin or a workflow manager starts a draft from it, edits it (autosaved), sends it for
 * approval and another one publishes it (a Superadmin their own only by override, with a reason). Used by lists the
 * recons that use it and marks those on an older version.
 */
export function LibraryEditor({ spaceId, id }: { spaceId: string; id: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const d = spaceWorkflow(spaceId, id);
  const list = `/spaces/${encodeURIComponent(spaceId)}/workflows`;
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
  const hasName = !!name.trim(), picked = levels.length > 0 && levels.every((l) => !emptyGroups(l).length);
  const complete = hasName && picked;
  const blockedWhy = complete ? null : `${[!hasName && "Name the workflow", !picked && "pick who approves every group"].filter(Boolean).join(" and ")} to send it.`.replace(/^./, (c) => c.toUpperCase());
  // a blocked Send shows where: the name's error, and the first level with a group naming nobody opens with its error
  const [nameChecked, setNameChecked] = useState(false);
  const [reveal, setReveal] = useState(0);
  const showBlocked = () => {
    setNameChecked(true);
    if (!picked) setReveal((r) => r + 1);
    else document.getElementById("wf-name")?.focus();
  };

  const [save, setSave] = useState<Save>({ state: "idle" });
  const saving = useDelayedFlag(save.state === "saving");
  const [savedBody, setSavedBody] = useState<string | null>(null);
  const body = JSON.stringify({ spec: { ...spec, name: spec.name.trim() } });
  const pending = editing && view === "open" && unsaved(body, savedBody, JSON.stringify({ spec: draft!.spec }));
  useEffect(() => {
    if (!editing || view !== "open") return;
    // an incomplete draft (no name yet, a group naming nobody) saves too: nothing typed is lost; sending checks it
    if (!unsaved(body, savedBody, JSON.stringify({ spec: draft!.spec }))) return;
    const t = setTimeout(async () => {
      setSave({ state: "saving" });
      try {
        await api(`/api/spaces/${encodeURIComponent(spaceId)}/workflows/${encodeURIComponent(id)}/draft`, { method: "PATCH", body });
        setSavedBody(body);
        setSave({ state: "saved", at: Date.now() });
        void qc.invalidateQueries({ predicate: (x) => JSON.stringify(x.queryKey).includes("/used-by") });
      } catch (e) { setSave({ state: "error", error: errorText(e) }); }
    }, 700);
    return () => clearTimeout(t);
  }, [spec, editing, view, savedBody]); // eslint-disable-line react-hooks/exhaustive-deps -- the draft and url follow `editing` and `id`

  const [busy, setBusy] = useState<string | null>(null);
  async function run(label: string, path: string, body: object | undefined, done: string): Promise<boolean> {
    setBusy(label);
    try {
      const next = await api<LibraryDetailDto | null>(`/api/spaces/${encodeURIComponent(spaceId)}/workflows/${encodeURIComponent(id)}${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      void qc.invalidateQueries({ queryKey: APPROVALS_KEY });
      toast(done);
      if (!next) { router.push(list); return true; } // a never-published workflow went with its draft
      qc.setQueryData(d.key, next);
      setSavedBody(null);
      return true;
    } catch (e) { toast.error(errorText(e)); return false; } finally { setBusy(null); }
  }

  if (isNotFound(q.error)) return <DetailNotFound title="Workflow" noun="workflow" list={{ href: list, label: "Workflows" }} />;
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
      confirm: { title: `Archive ${w.name}`, description: "Recons can no longer pick it. It is refused while a recon still uses it.", actionLabel: "Archive workflow", onConfirm: async () => { await run("archive", "/archive", undefined, "Workflow archived."); } },
    }] : []),
  ];
  const named = new Map(w.people.map((p) => [p.id, p.name ?? "A removed user"]));
  for (const u of users.data?.items ?? []) named.set(u.id, u.name);
  const options = { people: [...named].map(([pid, pname]) => ({ id: pid, name: pname })), globalRoles: w.globalRoles };
  const readOnly = !(editing && view === "open");

  return (
    <div className="grid gap-section">
      <PageHeader title={(!readOnly && name.trim()) || w.name}
        description={`${levels.length} ${levels.length === 1 ? "level" : "levels"} · approves in order, every group in a level must approve`}
        status={<>
          <StatusChip health={status.health} label={status.label} />
          {!readOnly && (
            <span role="status" className="text-caption text-fg-3">
              {saving ? "Saving…"
                : save.state === "saved" ? <span key={save.at} className="inline-flex items-center gap-1 animate-pop"><Icon icon={CheckIcon} className="text-healthy-ink" />Saved {formatTime(save.at!)}</span>
                  : save.state === "error" ? <span className="text-down-ink">Not saved: {save.error}</span> : "Changes save as you go"}
            </span>
          )}
        </>} more={more.length ? more : undefined}
        actions={!w.open && w.canEdit && !w.archived
          ? <Button type="button" variant="ghost" onClick={() => void run("start", "/draft", undefined, "Draft started from the live version.")} disabled={!!busy} aria-busy={busy === "start" || undefined}>
              <Icon icon={busy === "start" ? SpinnerIcon : EditIcon} className={busy === "start" ? "motion-safe:animate-spin" : undefined} />Edit workflow
            </Button>
          : draft && w.canEdit
            ? <BlockedButton type="button" onClick={() => void run("submit", "/draft/submit", undefined, "Sent for approval.")} disabled={!!busy || (complete && pending)} aria-busy={busy === "submit" || undefined}
                reason={blockedWhy} onBlockedPress={showBlocked}>
                {busy === "submit" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Send for approval
              </BlockedButton>
            : undefined} />

      {draft?.reviewComment && <Notice tone="warn">Sent back by {draft.decidedBy?.name ?? "a reviewer"}: “{draft.reviewComment}”</Notice>}
      {w.open?.status === "in_review" && (
        <ReviewPanel open={w.open} blocked={w.reviewBlocked} overrideOnly={w.overrideOnly} busy={busy}
          onDecide={(how, body) => run(how, `/review/${how}`, body, how === "approve" ? `Version ${w.open!.version} is live.` : "Sent back to its maker.")} />
      )}

      <div className="grid items-start gap-section xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="grid min-w-0 gap-4">
          {w.open && w.published && (
            <Segmented label="Version shown" value={view} onChange={setView}
              options={[{ value: "open", label: w.open.status === "draft" ? `Draft ${w.open.version}` : `Version ${w.open.version}` }, { value: "live", label: `Live · ${w.published.version}` }]} />
          )}
          <Field id="wf-name" label="Name" required error={!readOnly && nameChecked && !hasName ? "Name the workflow." : null}>
            <Input id="wf-name" value={name} maxLength={RULE_NAME_MAX} disabled={readOnly} onChange={(e) => setName(e.target.value)} placeholder="Treasury head" className="md:max-w-md" />
          </Field>
          <Levels levels={levels} onChange={setLevels} options={options} disabled={readOnly} reveal={reveal} />
        </div>
        <div id="used-by" className="min-w-0 scroll-mt-(--topbar-h) xl:sticky xl:top-(--topbar-h)">
          <UsedBy spaceId={spaceId} id={id} />
        </div>
      </div>
    </div>
  );
}
