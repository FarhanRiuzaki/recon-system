"use client";

// A report template's draft (spec "Draft: Wizard, five steps"; owner: the recon setup's behaviour): it saves itself a
// moment after each change (the header says Saved / Saving… / Not saved · Retry), the "Setup progress" panel marks
// each step, Next and Back walk them; Test makes a sample from real dates; Review and submit sends it (an official one
// to a config checker).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ReportSpec, ReportVersionDto } from "@starterkit/shared/contracts/reports";
import { FIELD_LABEL } from "@starterkit/shared/recon";
import { RECON_INFO_FIELDS, RECON_INFO_LABEL, RESULT_STATUS_LABEL, RESULT_STATUSES } from "@starterkit/shared/results";
import { REPORT_FORMATS, REPORT_KINDS } from "@starterkit/shared/reports";
import { BlockedButton, Checkbox, Field, Notice, Panel, Segmented, StatTile, StatTiles } from "@starterkit/ui/ds";
import { Wizard } from "@starterkit/ui/ds/wizard";
import { BreakdownCard } from "@starterkit/ui/charts";
import { formatNumber, formatPercent } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { toast } from "@starterkit/ui/ui/toast";
import { SortableList } from "@/components/sortable-list";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { FORMAT_LABEL, KIND_LABEL, sampleLine } from "./report-text";
import { firstProblem, REPORT_STEPS, type ReportStep, stepProblem, toggleStatus, withFormat, withKind } from "./spec-model";
import { serialSaver } from "./saver";
import { reportsApi, reportsHref, type TestResult, useSampleState, useTemplate, useTemplateActions } from "./use-reports";

/** The columns a report can hold: either side's core fields and the recon's info (keys as the API takes them). */
const COLUMN_OPTIONS = [
  ...(["a", "b"] as const).flatMap((s) => (Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[]).map((f) => ({ key: `${s}:${f}`, label: `${FIELD_LABEL[f]} ${s.toUpperCase()}` }))),
  ...RECON_INFO_FIELDS.map((f) => ({ key: `recon:${f}`, label: RECON_INFO_LABEL[f] })),
];
const labelOf = (key: string) => COLUMN_OPTIONS.find((o) => o.key === key)?.label ?? key;
const SAVE_DELAY_MS = 800;

export function DraftWizard({ spaceId, templateId, versionId: asked }: { spaceId: string; templateId: string; versionId: string | null }) {
  const router = useRouter();
  const { template, versions } = useTemplate(spaceId, templateId);
  const act = useTemplateActions(spaceId, templateId);
  // the version asked for, else the template's open draft (or the one waiting for approval)
  const v = versions.data?.items.find((x) => (asked ? x.id === asked : x.status === "draft" || x.status === "waiting"));
  const versionId = v?.id ?? "";
  // the draft as edited here (null: as loaded); `saved` = the spec the API holds, as JSON
  const [edited, setSpec] = useState<ReportSpec | null>(null);
  const spec = edited ?? v?.spec ?? null;
  const [step, setStep] = useState<ReportStep>(1);
  const [reached, setReached] = useState<ReportStep>(1);
  const [save, setSave] = useState<"saved" | "saving" | "failed">("saved");
  const [busy, setBusy] = useState(false);
  // the spec the API holds, as JSON ("" = as loaded)
  const [savedJson, setSavedJson] = useState("");
  const saver = useMemo(() => serialSaver<ReportSpec>(async (s) => {
    setSave("saving");
    try { await act.save(versionId, { spec: s }); setSavedJson(JSON.stringify(s)); setSave("saved"); } catch { setSave("failed"); }
  }), [act, versionId]);
  // autosave a moment after the last change (the recon builder's rule)
  useEffect(() => {
    if (!edited || JSON.stringify(edited) === (savedJson || JSON.stringify(v?.spec)) || v?.status !== "draft") return;
    // one save at a time, the latest last (serialSaver): an older save never lands after a newer one
    const t = setTimeout(() => saver.push(edited), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [edited, v?.status, v?.spec, saver, savedJson]);
  if (!spec || !v || !template.data) return <PageHeader title="Edit draft" trail={[{ label: "Reports", href: reportsHref(spaceId, "/templates") }]} />;
  const readOnly = v.status !== "draft";
  const change = (fn: (s: ReportSpec) => ReportSpec) => { if (!readOnly) setSpec((s) => fn(s ?? spec)); };
  const go = (n: ReportStep) => { setStep(n); setReached((r) => (n > r ? n : r)); };
  const steps = REPORT_STEPS.map((s) => ({
    id: String(s.n), label: s.label,
    status: (s.n === step ? "current" : s.n < step || reached >= s.n ? (stepProblem(spec, s.n) ? "error" : "done") : "todo") as "current" | "done" | "error" | "todo",
  }));
  const blocked = firstProblem(spec);
  const submit = async () => {
    setBusy(true);
    try {
      await saver.flush();
      if (edited && JSON.stringify(edited) !== (savedJson || JSON.stringify(v.spec))) await act.save(versionId, { spec: edited });
      const r: ReportVersionDto = await act.submit(versionId);
      toast(r.status === "active" ? "Sent: the version is active." : "Sent to a config checker for approval.");
      router.push(reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}`));
    } catch (e) { toast.error(errorText(e)); setBusy(false); }
  };
  const saveLine = save === "saving" ? "Saving…" : save === "failed" ? <span className="text-down-ink">Not saved · <button type="button" className="underline" onClick={() => setSpec({ ...spec })}>Retry</button></span> : "Saved";
  return (
    <div className="grid gap-section">
      <PageHeader title={`${template.data.name} · draft v${v.version}`} crumb={`Draft v${v.version}`}
        trail={[{ label: "Reports", href: reportsHref(spaceId, "/templates") }, { label: template.data.name, href: reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}`) }]}
        description={<>{template.data.recon.name} · {readOnly ? (v.status === "waiting" ? "Waiting for approval: read only" : "Read only") : saveLine}</>} />
      {v.note && <Notice tone="warn">Sent back: {v.note}</Notice>}
      <Wizard title="Setup progress" steps={steps}>
        <form noValidate className="grid gap-section" onSubmit={(e) => { e.preventDefault(); if (step < 5) go((step + 1) as ReportStep); else void submit(); }}>
          <fieldset disabled={readOnly} className="grid min-w-0 gap-section">
            {step === 1 && <ContentStep spec={spec} change={change} />}
            {step === 2 && <ColumnsStep spec={spec} change={change} />}
            {step === 3 && <OutputStep spec={spec} change={change} />}
            {/* the Test reads the stored draft: the edits are saved first */}
            {step === 4 && <TestStep spaceId={spaceId} versionId={versionId} spec={spec} run={async (b) => {
              await saver.flush();
              if (edited && JSON.stringify(edited) !== (savedJson || JSON.stringify(v.spec))) { await act.save(versionId, { spec: edited }); setSavedJson(JSON.stringify(edited)); }
              return act.test(versionId, b);
            }} />}
            {step === 5 && <ReviewStep spec={spec} change={change} />}
          </fieldset>
          {stepProblem(spec, step) && <p role="alert" className="text-body-sm text-down-ink">{stepProblem(spec, step)}</p>}
          <div className="flex flex-wrap gap-2">
            {step > 1 && <Button type="button" variant="ghost" onClick={() => go((step - 1) as ReportStep)}>Back</Button>}
            {step < 5 ? <Button type="submit">Next: {(REPORT_STEPS as readonly { label: string }[])[step]!.label}</Button>
              : readOnly ? null : blocked ? <BlockedButton reason={`${REPORT_STEPS[blocked.n - 1]!.label}: ${blocked.why}`}>Send report version</BlockedButton>
              : <Button type="submit" disabled={busy} aria-busy={busy || undefined}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Send report version</Button>}
          </div>
        </form>
      </Wizard>
    </div>
  );
}

type StepProps = { spec: ReportSpec; change: (fn: (s: ReportSpec) => ReportSpec) => void };

function ContentStep({ spec, change }: StepProps) {
  return (
    <Panel title="Content" description="What each file holds and which results go in it." bodyClassName="grid gap-4">
      <Segmented label="Holds" value={spec.kind} onChange={(k) => change((s) => withKind(s, k))} options={REPORT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      <fieldset className="grid gap-2">
        <legend className="text-label text-fg">Results <span className="text-fg-3">(none ticked: every result)</span></legend>
        <div className="grid gap-1 md:grid-cols-3">
          {RESULT_STATUSES.map((st) => <Checkbox key={st} checked={spec.rows.statuses.includes(st)} label={RESULT_STATUS_LABEL[st]} onToggle={() => change((s) => toggleStatus(s, st))} />)}
        </div>
      </fieldset>
      <Field id="report-side" label="Sides">
        <Select id="report-side" value={spec.rows.side} onChange={(e) => change((s) => ({ ...s, rows: { ...s.rows, side: e.target.value as ReportSpec["rows"]["side"] } }))}>
          <option value="both">Both sides</option><option value="a">Results holding side A</option><option value="b">Results holding side B</option>
        </Select>
      </Field>
    </Panel>
  );
}

function ColumnsStep({ spec, change }: StepProps) {
  const [add, setAdd] = useState(COLUMN_OPTIONS[0]!.key);
  if (spec.kind === "daily_summary") return <Panel title="Columns and groups"><p className="text-body-sm text-fg-2">A daily summary holds per business date: results, matched, breaks, match rate, results by status, amounts per currency and breaks by reason.</p></Panel>;
  const free = COLUMN_OPTIONS.filter((o) => !spec.columns.some((c) => c.key === o.key));
  return (
    <Panel title="Columns and groups" description="Drag to order the columns; each header is what the file says." bodyClassName="grid gap-4">
      <SortableList items={spec.columns} getKey={(c) => c.key} noun="Column" label="Columns in file order"
        onReorder={(_, from, to) => change((s) => { const cs = [...s.columns]; const [m] = cs.splice(from, 1); cs.splice(to, 0, m!); return { ...s, columns: cs }; })}
        renderItem={(c, { handle }) => (
          <div className="flex items-center gap-2 py-1">
            {handle}
            <span className="w-40 shrink-0 text-body-sm text-fg-2">{labelOf(c.key)}</span>
            <Input aria-label={`Header of ${labelOf(c.key)}`} value={c.header} onChange={(e) => change((s) => ({ ...s, columns: s.columns.map((x) => (x.key === c.key ? { ...x, header: e.target.value } : x)) }))} />
            <Button type="button" variant="remove" size="icon" aria-label={`Remove ${labelOf(c.key)}`} onClick={() => change((s) => ({ ...s, columns: s.columns.filter((x) => x.key !== c.key), groups: s.groups.filter((g) => g !== c.key) }))}><Icon icon={RemoveIcon} /></Button>
          </div>
        )} />
      {free.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <Field id="report-add-column" label="Column"><Select id="report-add-column" value={free.some((o) => o.key === add) ? add : free[0]!.key} onChange={(e) => setAdd(e.target.value)}>{free.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</Select></Field>
          <Button type="button" variant="create" onClick={() => { const k = free.some((o) => o.key === add) ? add : free[0]!.key; change((s) => ({ ...s, columns: [...s.columns, { key: k, header: labelOf(k) }] })); }}><Icon icon={AddIcon} />Add column</Button>
        </div>
      )}
      {spec.kind === "grouped" && (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Field key={i} id={`report-group-${i}`} label={i === 0 ? "Group by" : "Then by"}>
              <Select id={`report-group-${i}`} value={spec.groups[i] ?? ""} onChange={(e) => change((s) => ({ ...s, groups: [...s.groups.slice(0, i), ...(e.target.value ? [e.target.value] : [])].slice(0, 2) }))}>
                <option value="">{i === 0 ? "Pick a column" : "None"}</option>
                {spec.columns.map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
              </Select>
            </Field>
          ))}
          <Checkbox checked={spec.totals.some((t) => t.fn === "sum")} label="Sum of the amount per group" onToggle={() => change((s) => ({ ...s, totals: s.totals.some((t) => t.fn === "sum") ? s.totals.filter((t) => t.fn !== "sum") : [...s.totals, { fn: "sum", column: "a:amount_minor" }] }))} />
        </div>
      )}
    </Panel>
  );
}

function OutputStep({ spec, change }: StepProps) {
  const o = spec.output;
  const set = (patch: Partial<ReportSpec["output"]>) => change((s) => ({ ...s, output: { ...s.output, ...patch } }));
  return (
    <Panel title="Output" description="The file's format and name; tokens {recon}, {template}, {from}, {to} and {date}." bodyClassName="grid gap-4 md:grid-cols-2">
      <div className="md:col-span-2"><Segmented label="Format" value={o.format} onChange={(f) => change((s) => withFormat(s, f))} options={REPORT_FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))} /></div>
      {o.format === "pdf" && spec.kind === "transactions" && <div className="md:col-span-2"><Notice>A PDF holds at most 5,000 rows. Use CSV or Excel for more.</Notice></div>}
      <Field id="report-file-name" label="File name" required><Input id="report-file-name" className="font-mono" value={o.fileName} onChange={(e) => set({ fileName: e.target.value })} /></Field>
      <Field id="report-masking" label="Customer data" note={spec.official ? undefined : "Full customer data needs an official report (step 5)."}>
        <Select id="report-masking" value={o.masking} onChange={(e) => set({ masking: e.target.value as "masked" | "full" })}>
          <option value="masked">Masked (····1234)</option><option value="full">Full</option>
        </Select>
      </Field>
      {o.format === "pdf" && <>
        <Field id="report-title" label="Title"><Input id="report-title" value={o.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} /></Field>
        <Field id="report-subtitle" label="Line under the title"><Input id="report-subtitle" value={o.subtitle ?? ""} onChange={(e) => set({ subtitle: e.target.value || undefined })} placeholder="For OJK" /></Field>
      </>}
    </Panel>
  );
}

function TestStep({ spaceId, spec, run }: { spaceId: string; versionId: string; spec: ReportSpec; run: (b: { from: string; to: string }) => Promise<TestResult> }) {
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const sample = useSampleState(spaceId, result?.sampleId);
  const line = sampleLine(sample);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    try { setResult(await run({ from, to: to || from })); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Panel title="Test" description="Read real dates with this draft. Customer data is always masked here; nothing is listed in Files." bodyClassName="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="test-from" label="From"><Input id="test-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field id="test-to" label="To"><Input id="test-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        {from ? <Button type="button" variant="secondary" disabled={busy} aria-busy={busy || undefined} onClick={() => void go()}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Test report</Button>
          : <BlockedButton variant="secondary" reason="Pick a date to read.">Test report</BlockedButton>}
      </div>
      {error && <p role="alert" className="text-body-sm text-down-ink">{error}</p>}
      {result?.summary && result.summary.map((d) => (
        <div key={d.date} className="grid gap-3">
          <h3 className="text-label text-fg">{d.date}</h3>
          <StatTiles>
            <StatTile label="Results" value={formatNumber(d.total)} /><StatTile label="Matched" value={formatNumber(d.matched)} />
            <StatTile label="Breaks" value={formatNumber(d.breaks)} /><StatTile label="Match rate" value={d.matchRate === null ? "—" : formatPercent(d.matchRate, 1)} />
          </StatTiles>
          <BreakdownCard title="Results by status" otherLabel="Other statuses" parts={Object.entries(d.byStatus).map(([s, n]) => ({ label: RESULT_STATUS_LABEL[s as keyof typeof RESULT_STATUS_LABEL] ?? s, value: n }))}
            empty={{ title: "No results on this date", description: "Results appear once a run of the recon covers the date." }} />
        </div>
      ))}
      {result && !result.summary && (result.rows.length ? (
        <div className="scroll-quiet overflow-x-auto">
          <table className="w-full text-body-sm"><thead><tr>{spec.columns.map((c) => <th key={c.key} className="px-2 py-1 text-left font-normal text-fg-3">{c.header}</th>)}</tr></thead>
            <tbody>{result.rows.map((r, i) => <tr key={i} className="border-t border-line">{spec.columns.map((c) => <td key={c.key} className="px-2 py-1">{r.values[c.key] ?? ""}</td>)}</tr>)}</tbody></table>
        </div>) : <p className="text-body-sm text-fg-3">No results on these dates match the rows of step 1.</p>)}
      {result && <p className="text-body-sm">{line.link
        ? <a className="text-primary hover:underline" href={reportsApi(spaceId, `/samples/${encodeURIComponent(result.sampleId)}`)} download>{line.text}</a>
        : <span className={sample?.status === "failed" ? "text-down-ink" : "text-fg-3"}>{line.text}</span>} <span className="text-fg-3">(kept 24 hours)</span></p>}
    </Panel>
  );
}

function ReviewStep({ spec, change }: StepProps) {
  return (
    <Panel title="Review and submit" description="When files are made, and who approves this version." bodyClassName="grid gap-3">
      <Checkbox checked={spec.when.afterRun} label="After every run, for its dates" onToggle={() => change((s) => ({ ...s, when: { ...s.when, afterRun: !s.when.afterRun } }))} />
      <Checkbox checked={spec.when.onRequest} label="On request, for a date range" onToggle={() => change((s) => ({ ...s, when: { ...s.when, onRequest: !s.when.onRequest } }))} />
      <Checkbox checked={spec.official} label="Official report (for a regulator or an outside party): a config checker approves each version" onToggle={() => change((s) => ({ ...s, official: !s.official, output: !s.official ? s.output : { ...s.output, masking: "masked" } }))} />
    </Panel>
  );
}
