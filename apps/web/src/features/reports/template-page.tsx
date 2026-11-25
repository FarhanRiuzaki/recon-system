"use client";

// A report template (like a recon's page): its active version's settings, its latest files, its versions. Edit
// draft opens the Wizard (making the next draft from the active version when none is open); Retire is in ⋯.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { mayDo } from "@starterkit/shared/spaces";
import { BlockedButton, Panel, StatusChip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { EditIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import dynamic from "next/dynamic";
import { DetailNotFound } from "@/components/detail-not-found";
import { PageHeader } from "@/components/shell/page-header";
import { errorText, isNotFound } from "@/lib/client/api";
import { statusTone } from "@/lib/shared/categories";
import { NEW_TEMPLATE_REASON, TEMPLATE_STATUS_LABEL } from "./report-text";
import { SpecRows } from "./spec-rows";
import { reportsHref, useSpaceRoles, useTemplate, useTemplateActions } from "./use-reports";

const GenerateDialog = dynamic(() => import("./generate-dialog").then((m) => m.GenerateDialog), { ssr: false });

export function TemplatePage({ spaceId, templateId }: { spaceId: string; templateId: string }) {
  const router = useRouter();
  const { template, versions } = useTemplate(spaceId, templateId);
  const act = useTemplateActions(spaceId, templateId);
  const roles = useSpaceRoles(spaceId);
  const [generate, setGenerate] = useState(false);
  const t = template.data;
  if (template.error && isNotFound(template.error)) return <DetailNotFound title="Report template not found" noun="report template" list={{ href: reportsHref(spaceId, "/templates"), label: "Report templates" }} />;
  if (!t) return <PageHeader title="Report template" trail={[{ label: "Reports", href: reportsHref(spaceId, "/templates") }]} />;
  const vs = versions.data?.items ?? [];
  const active = vs.find((v) => v.status === "active");
  const open = vs.find((v) => v.status === "draft" || v.status === "waiting");
  const shown = active ?? open;
  const edit = async () => {
    try {
      const v = open?.status === "draft" ? open : await act.newDraft();
      router.push(reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}/draft?version=${encodeURIComponent(v.id)}`));
    } catch (e) { toast.error(errorText(e)); }
  };
  const editor = mayDo(roles, "editReports");
  return (
    <div className="grid gap-section">
      <PageHeader title={t.name} trail={[{ label: "Reports", href: reportsHref(spaceId, "/templates") }]}
        status={<StatusChip health={statusTone(t.status === "active" ? "active" : t.status === "retired" ? "retired" : t.status === "waiting" ? "waiting" : "draft")} label={`${TEMPLATE_STATUS_LABEL[t.status]}${t.activeVersion ? ` · v${t.activeVersion}` : ""}`} />}
        description={`${t.recon.name}${open ? ` · draft v${vs.find((v) => v.id === open.id)?.version} ${open.status === "waiting" ? "waiting for approval" : "open"}` : ""}`}
        actions={<>
          {mayDo(roles, "generateReports") && t.status === "active" && <Button variant="secondary" onClick={() => setGenerate(true)}>Generate report</Button>}
          {t.status === "retired" ? null : editor ? <Button variant="edit" onClick={() => void edit()}><Icon icon={EditIcon} />{open?.status === "waiting" ? "View draft" : "Edit draft"}</Button> : <BlockedButton variant="edit" reason={NEW_TEMPLATE_REASON}><Icon icon={EditIcon} />Edit draft</BlockedButton>}
        </>}
        more={editor && t.status !== "retired" ? [{ label: "Retire report template", destructive: true, confirm: {
          title: "Retire this report template?", description: "No more files are made from it, after runs or on request. Its files stay and can still be downloaded.",
          actionLabel: "Retire report template", onConfirm: async () => { await act.retire(); toast("Retired the report template."); },
        } }] : undefined} />
      <div className="grid gap-section xl:grid-cols-2">
        <Panel title={active ? `Version ${active.version}` : "Draft"} description={active ? "The version files are made from." : "Not active yet: send the draft."}>
          {shown ? <SpecRows spec={shown.spec} /> : null}
        </Panel>
        <Panel title="Files and versions">
          <ul className="grid gap-2 text-body-sm">
            <li><Link className="text-primary hover:underline" href={reportsHref(spaceId, `?template=${encodeURIComponent(templateId)}`)}>See this report&apos;s files</Link></li>
            {vs.map((v) => (
              <li key={v.id} className="flex items-center gap-2">
                <Link className="text-fg hover:underline" href={reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(v.id)}`)}>Version {v.version}</Link>
                <span className="text-fg-3">{v.status === "waiting" ? "Waiting approval" : v.status[0]!.toUpperCase() + v.status.slice(1)}{v.madeBy ? ` · ${v.madeBy.name}` : ""}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      {generate && <GenerateDialog spaceId={spaceId} template={templateId} onClose={() => setGenerate(false)} />}
    </div>
  );
}
