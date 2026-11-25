"use client";

// A report template version (VersionLayout, like a recon's or a source's): its settings, and for a version waiting
// for approval the config checker's decision (approve, or send back with a note). Not by anyone who worked on it.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { mayDo } from "@starterkit/shared/spaces";
import { Field, Notice, Panel } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { DetailNotFound } from "@/components/detail-not-found";
import { PageHeader } from "@/components/shell/page-header";
import { VersionLayout } from "@/components/version-layout";
import { errorText } from "@/lib/client/api";
import { DesignView } from "./designer-page";
import { reportsHref, useSpaceRoles, useTemplate, useTemplateActions } from "./use-reports";

const STATUS = { draft: "Draft", waiting: "Waiting for approval", active: "Active", superseded: "Superseded" } as const;

export function VersionPage({ spaceId, templateId, versionId }: { spaceId: string; templateId: string; versionId: string }) {
  const router = useRouter();
  const { template, versions } = useTemplate(spaceId, templateId);
  const act = useTemplateActions(spaceId, templateId);
  const checker = mayDo(useSpaceRoles(spaceId), "approveVersion");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const v = versions.data?.items.find((x) => x.id === versionId);
  const t = template.data;
  const trail = [{ label: "Reports", href: reportsHref(spaceId, "/templates") }, ...(t ? [{ label: t.name, href: reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}`) }] : [])];
  if (versions.data && !v) return <DetailNotFound title="Version not found" noun="report version" list={{ href: reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}`), label: t?.name ?? "Report template" }} />;
  if (!v || !t) return <VersionLayout header={<PageHeader title="Report version" trail={trail} />} />;
  const decide = async (what: "approve" | "reject") => {
    if (what === "reject" && !note.trim()) { toast.error("Say what to change before sending it back."); return; }
    setBusy(what);
    try {
      await (what === "approve" ? act.approve(versionId, note.trim() || undefined) : act.reject(versionId, note.trim()));
      toast(what === "approve" ? "Approved: the version is active." : "Sent back to its maker.");
      router.push(reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}`));
    } catch (e) { toast.error(errorText(e)); setBusy(null); }
  };
  return (
    <VersionLayout
      header={<PageHeader title={`${t.name} · version ${v.version}`} crumb={`Version ${v.version}`} trail={trail} description={`${STATUS[v.status]}${v.madeBy ? ` · made by ${v.madeBy.name}` : ""}${v.approvedBy ? ` · approved by ${v.approvedBy.name}` : ""}`} />}
      notice={v.note ? <Notice tone={v.status === "draft" ? "warn" : "info"}>{v.status === "draft" ? "Sent back" : "Checker's note"}: {v.note}</Notice> : undefined}
      decision={v.status === "waiting" && checker ? (
        <Panel title="Decision" description="An official report's version is active once a config checker who didn't work on it approves it." bodyClassName="grid gap-3">
          <Field id="report-note" label="Note" note="Needed to send it back: what to change.">
            <Textarea id="report-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy} aria-busy={busy === "approve" || undefined} onClick={() => void decide("approve")}>Approve version</Button>
            <Button variant="caution" disabled={!!busy} aria-busy={busy === "reject" || undefined} onClick={() => void decide("reject")}>Send back</Button>
          </div>
        </Panel>) : undefined}
      settings={<DesignView spaceId={spaceId} templateId={templateId} version={v} />} />
  );
}
