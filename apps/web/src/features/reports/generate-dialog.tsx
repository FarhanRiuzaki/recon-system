"use client";

// Generate report (spec "Reports page"): an active template made on request and a date range (≤ 92 days); queued, it
// appears in Files with its progress. Dates not signed off when it is read make it Not final.
import { useState } from "react";
import { BlockedButton, Field, Notice } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { toast } from "@starterkit/ui/ui/toast";
import { errorText } from "@/lib/client/api";
import { FORMAT_LABEL, generateProblem } from "./report-text";
import { useActiveTemplates, useReportActions } from "./use-reports";

export function GenerateDialog({ spaceId, recon, template, onClose }: { spaceId: string; recon?: string; template?: string; onClose: () => void }) {
  const templates = useActiveTemplates(spaceId, recon).data?.items ?? [];
  const { generate } = useReportActions(spaceId);
  const [pick, setPick] = useState(template ?? "");
  const chosen = pick || templates[0]?.id || "";
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const why = !chosen ? "Activate a report template first: Templates, then send a draft." : generateProblem(from, to);
  const send = async () => {
    if (why || busy) return;
    setBusy(true); setError(null);
    try {
      await generate({ templateId: chosen, from, to });
      toast("Making the report. You'll find it in Files.");
      onClose();
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent phone="top">
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} noValidate>
          <DialogHeader>
            <DialogTitle>Generate report</DialogTitle>
            <DialogDescription>The file is made in the background and kept. Every download is logged.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <fieldset disabled={busy} className="grid min-w-0 gap-4">
              <Field id="report-template" label="Report">
                <Select id="report-template" value={chosen} onChange={(e) => setPick(e.target.value)}>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.recon.name} · {FORMAT_LABEL[t.format]}</option>)}
                </Select>
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field id="report-from" label="From"><Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                <Field id="report-to" label="To"><Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              </div>
              <Notice>Dates not signed off when the report is read are marked Not final on every page.</Notice>
              {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
            </fieldset>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            {why ? <BlockedButton variant="create-solid" reason={why}><Icon icon={AddIcon} />Generate report</BlockedButton>
              : <Button type="submit" variant="create-solid" disabled={busy} aria-busy={busy || undefined}><Icon icon={busy ? SpinnerIcon : AddIcon} className={busy ? "motion-safe:animate-spin" : undefined} />Generate report</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
