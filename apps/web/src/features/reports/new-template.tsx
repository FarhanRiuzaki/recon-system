"use client";

// New report template (spec "New template"): a filled starting point (Daily summary, Break detail, Matched list, or
// Blank), the recon it reports on and a name; Create opens the draft's Wizard.
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReportStart } from "@starterkit/shared/reports";
import { Field, FormFooter, InteractiveCard, Panel } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { cn } from "@starterkit/ui/lib/cn";
import { PageHeader } from "@/components/shell/page-header";
import { api, errorText } from "@/lib/client/api";
import { REPORTS_KEY } from "@/lib/shared/queries";
import { createTemplate, reportsHref } from "./use-reports";

const STARTS: { start: ReportStart; title: string; text: string }[] = [
  { start: "daily_summary", title: "Daily summary", text: "One page per business date: results, matched, breaks, match rate, breaks by reason. PDF, after every run." },
  { start: "break_detail", title: "Break detail", text: "Every unmatched result with its reference, amount, reason and assignee. Excel." },
  { start: "matched_list", title: "Matched list", text: "Every matched result with both references and the amount. CSV, for an audit extract." },
  { start: "blank", title: "Blank", text: "Transactions to CSV with no column yet: set it up from the start." },
];

export function NewTemplate({ spaceId }: { spaceId: string }) {
  const router = useRouter();
  const recons = useQuery({ queryKey: [...REPORTS_KEY, "recons", spaceId], queryFn: () => api<Page<{ id: string; name: string }>>(`/api/spaces/${encodeURIComponent(spaceId)}/recons?pageSize=100`) }).data?.items ?? [];
  const [start, setStart] = useState<ReportStart>("daily_summary");
  const [recon, setRecon] = useState(useSearchParams().get("recon") ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = recon || recons[0]?.id || "";
  const create = async () => {
    if (!name.trim()) { setError("Name the report."); return; }
    setBusy(true); setError(null);
    try {
      const t = await createTemplate(spaceId, { configId: chosen, name: name.trim(), start });
      router.push(reportsHref(spaceId, `/templates/${encodeURIComponent(t.id)}/draft`));
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <form className="grid gap-section" noValidate onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <PageHeader title="New report template" trail={[{ label: "Reports", href: reportsHref(spaceId, "/templates") }]} description="Start from a filled template and change it, or start blank." />
      <Panel title="Start from">
        <div className="grid gap-3 md:grid-cols-2">
          {STARTS.map((s) => (
            <InteractiveCard key={s.start} aria-pressed={start === s.start} onClick={() => setStart(s.start)} className={cn(start === s.start && "ring-2 ring-primary")}>
              <span className="grid gap-1 text-left"><span className="font-medium text-fg">{s.title}</span><span className="text-body-sm text-fg-2">{s.text}</span></span>
            </InteractiveCard>
          ))}
        </div>
      </Panel>
      <Panel title="Report" bodyClassName="grid gap-4 md:grid-cols-2">
        <Field id="new-report-recon" label="Recon" required>
          <Select id="new-report-recon" value={chosen} onChange={(e) => setRecon(e.target.value)}>{recons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
        </Field>
        <Field id="new-report-name" label="Name" required error={error === "Name the report." ? error : undefined}>
          <Input id="new-report-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="KSEI daily recap" autoComplete="off" />
        </Field>
        {error && error !== "Name the report." && <p role="alert" className="text-body-sm text-down-ink md:col-span-2">{error}</p>}
      </Panel>
      <FormFooter primary={<Button type="submit" variant="create-solid" disabled={busy || !chosen} aria-busy={busy || undefined}><Icon icon={busy ? SpinnerIcon : AddIcon} className={busy ? "motion-safe:animate-spin" : undefined} />Create report template</Button>}
        cancel={<Button type="button" variant="ghost" onClick={() => router.push(reportsHref(spaceId, "/templates"))}>Cancel</Button>} />
    </form>
  );
}
