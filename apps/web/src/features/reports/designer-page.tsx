"use client";

// The report designer (spec 2026-11-26, owner: "sebebas user … drag and drop … in detail micro"): Data (left), the
// report as the file will be on real rows (centre), the settings of what is selected (right). Every edit is a pure
// function of the design (spec-model); it saves itself a moment later (one save at a time), undo/redo walk it, and the
// preview is rendered by the API with the file's own code. A draft is edited by a config maker; any other version, or
// anyone else, sees it read only.
import { DndContext, type DragEndEvent, type DragMoveEvent, DragOverlay, type DragStartEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { ReportSpec, ReportVersionDto } from "@starterkit/shared/contracts/reports";
import { type ReportFormat } from "@starterkit/shared/reports";
import { mayDo } from "@starterkit/shared/spaces";
import { BlockedButton, type ListedField, Notice, Panel, Segmented, TypeBadge } from "@starterkit/ui/ds";
import { appDate } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { toast } from "@starterkit/ui/ui/toast";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { DataPane, type DragItem, type Special } from "./data-pane";
import { placement } from "./drop-model";
import { InspectorPane } from "./inspector-pane";
import { type DropMark, ReportCanvas, type Selected } from "./report-canvas";
import { EDIT_DRAFT_REASON, FORMAT_LABEL, sampleLine } from "./report-text";
import { serialSaver } from "./saver";
import {
  addColumn, addGroup, columnOfField, history, type History, keyAction, moveColumn, removeColumn, replaceField, sendProblem, setFormat, specialColumn,
} from "./spec-model";
import { reportsApi, reportsHref, useFields, usePreview, useSampleState, useSpaceRoles, useTemplate, useTemplateActions } from "./use-reports";

const SAVE_DELAY_MS = 800;
const yesterday = () => appDate(Date.now() - 86_400_000);

/** The fields of the dataset as a map by ref (labels, types, customer data). */
function useFieldMap(spaceId: string, templateId: string, spec: ReportSpec | null) {
  const q = useFields(spaceId, templateId, spec?.dataset ?? "results");
  const map = useMemo(() => new Map((q.data?.groups ?? []).flatMap((g) => g.fields.map((f) => [f.ref, f as ListedField] as const))), [q.data]);
  return { data: q.data, map };
}

/** A stored version's design, read only: the preview of its date (a version page, the template's overview). */
export function DesignView({ spaceId, templateId, version }: { spaceId: string; templateId: string; version: ReportVersionDto }) {
  const [date, setDate] = useState(yesterday);
  const fields = useFieldMap(spaceId, templateId, version.spec);
  const preview = usePreview(spaceId, templateId, version.id, version.spec, date, false);
  return (
    <Panel title="Design" description={`${FORMAT_LABEL[version.spec.output.format]} · preview on real rows, masked`}
      actions={<Input type="date" aria-label="Preview date" className="h-8 w-40" value={date} onChange={(e) => setDate(e.target.value)} />}>
      <DndContext>
        <ReportCanvas spec={version.spec} change={() => undefined} readOnly preview={preview} date={date} fields={fields.map} selected={{ kind: "report" }} select={() => undefined}
          drop={null} dragging={null} onAddField={() => undefined} />
      </DndContext>
    </Panel>
  );
}

export function DesignerPage({ spaceId, templateId, versionId: asked }: { spaceId: string; templateId: string; versionId: string | null }) {
  const router = useRouter();
  const { template, versions } = useTemplate(spaceId, templateId);
  const act = useTemplateActions(spaceId, templateId);
  const canEdit = mayDo(useSpaceRoles(spaceId), "editReports");
  const v = versions.data?.items.find((x) => (asked ? x.id === asked : x.status === "draft" || x.status === "waiting"));
  const versionId = v?.id ?? "";
  const readOnly = !v || v.status !== "draft" || !canEdit;

  // the design and its history (null until the version loads), the name, what is selected, the preview date
  const [hist, setHist] = useState<History | null>(null);
  const [loadedFor, setLoadedFor] = useState("");
  if (v && loadedFor !== v.id) { setLoadedFor(v.id); setHist(history.start(v.spec)); }
  const spec = hist?.now ?? null;
  const [name, setName] = useState<string | null>(null);
  const shownName = name ?? template.data?.name ?? "";
  const [selected, select] = useState<Selected>({ kind: "report" });
  const [date, setDate] = useState(yesterday);
  const fields = useFieldMap(spaceId, templateId, spec);
  const preview = usePreview(spaceId, templateId, versionId, spec, date, !readOnly);

  // saving: a moment after the last change, one save at a time (serialSaver), the latest last
  const [save, setSave] = useState<"saved" | "saving" | "failed">("saved");
  const [savedJson, setSavedJson] = useState("");
  const saver = useMemo(() => serialSaver<{ spec: ReportSpec; name: string }>(async (b) => {
    setSave("saving");
    try { await act.save(versionId, { spec: b.spec, ...(b.name.trim() ? { name: b.name.trim() } : {}) }); setSavedJson(JSON.stringify(b)); setSave("saved"); } catch { setSave("failed"); }
  }), [act, versionId]);
  const current = useMemo(() => (spec ? { spec, name: shownName } : null), [spec, shownName]);
  useEffect(() => {
    if (readOnly || !current || !v) return;
    const now = JSON.stringify(current);
    if (now === (savedJson || JSON.stringify({ spec: v.spec, name: template.data?.name ?? "" }))) return;
    const t = setTimeout(() => saver.push(current), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [current, readOnly, saver, savedJson, v, template.data?.name]);

  /** One edit of the design; `said` = a toast with Undo (for what a person may not have meant). */
  const change = (fn: (s: ReportSpec) => ReportSpec, said?: string) => {
    if (readOnly) return;
    setHist((h) => (h ? history.push(h, fn(h.now)) : h));
    if (said) toast.undo(said, () => setHist((h) => (h ? history.undo(h) : h)));
  };
  const undo = () => setHist((h) => (h ? history.undo(h) : h));
  const redo = () => setHist((h) => (h ? history.redo(h) : h));

  const addField = (f: ListedField, at?: number) => change((s) => addColumn(s, columnOfField(s, f), at), `Added “${f.label}”`);
  const addSpecial = (k: Special, at?: number) => change((s) => addColumn(s, specialColumn(s, k), at));

  // keys: undo, redo, Delete the selected column, Alt+arrows move it
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const el = document.activeElement as HTMLElement | null;
    const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
    const a = keyAction({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, typing, selected: selected.kind === "column" });
    if (!a || readOnly) return;
    e.preventDefault();
    if (a === "undo") return undo();
    if (a === "redo") return redo();
    if (selected.kind !== "column" || !spec) return;
    const i = spec.columns.findIndex((c) => c.id === selected.id);
    if (a === "remove") { change((s) => removeColumn(s, selected.id), `Removed “${spec.columns[i]?.header ?? ""}”`); select({ kind: "report" }); }
    if (a === "left" && i > 0) change((s) => moveColumn(s, selected.id, i - 1));
    if (a === "right" && i < spec.columns.length - 1) change((s) => moveColumn(s, selected.id, i + 2));
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // drag and drop: fields and "build your own" in, column headers to move
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor));
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [drop, setDrop] = useState<DropMark>(null);
  const markOf = (e: DragMoveEvent | DragEndEvent): DropMark => {
    const over = e.over;
    if (!over || !dragging) return null;
    if (over.id === "end") return { end: true };
    const columnId = (over.data.current as { columnId?: string } | undefined)?.columnId;
    if (!columnId) return null;
    const ev = e.activatorEvent as PointerEvent;
    const x = typeof ev.clientX === "number" ? ev.clientX + e.delta.x : over.rect.left + over.rect.width / 2;
    return { columnId, at: placement(x, over.rect, dragging.kind === "column" ? "column" : "field") };
  };
  const onDragEnd = (e: DragEndEvent) => {
    const item = dragging;
    const mark = markOf(e);
    setDragging(null); setDrop(null);
    if (!item || !spec || readOnly) return;
    if (e.over?.id === "group") { if (item.kind === "field") change((s) => addGroup(s, item.field.ref), `Grouped by ${item.field.label}`); return; }
    if (!mark) return;
    const at = "end" in mark ? spec.columns.length : spec.columns.findIndex((c) => c.id === mark.columnId) + (mark.at === "after" ? 1 : 0);
    if (item.kind === "column") { if (!("end" in mark) && mark.columnId === item.id) return; change((s) => moveColumn(s, item.id, at), `Moved “${item.label}”`); return; }
    if (item.kind === "field" && "columnId" in mark && mark.at === "replace") { change((s) => replaceField(s, mark.columnId, item.field), `“${item.field.label}” now fills the column`); return; }
    if (item.kind === "field") addField(item.field, at); else addSpecial(item.special, at);
  };

  // Test with real data: the edits stored first, then a masked sample of the preview date for the worker to make
  const [sampleId, setSampleId] = useState<string | undefined>(undefined);
  const sample = useSampleState(spaceId, sampleId);
  const line = sampleLine(sample);
  const [busy, setBusy] = useState(false);
  const flush = async () => { await saver.flush(); if (current && !readOnly) await act.save(versionId, { spec: current.spec, ...(current.name.trim() ? { name: current.name.trim() } : {}) }); };
  const test = async () => {
    try { await flush(); setSampleId((await act.test(versionId, { from: date, to: date })).sampleId); toast("Making a sample file of the preview date."); } catch (e) { toast.error(errorText(e)); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      await flush();
      const r = await act.submit(versionId);
      toast(r.status === "active" ? "Sent: the version is active." : "Sent to a config checker for approval.");
      router.push(reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}`));
    } catch (e) { toast.error(errorText(e)); setBusy(false); }
  };

  if (!spec || !v || !template.data) return <PageHeader title="Report design" trail={[{ label: "Reports", href: reportsHref(spaceId, "/templates") }]} />;
  const blocked = sendProblem(spec) ?? (preview.data?.problems[0]?.message ?? null);
  const saveLine = save === "saving" ? "Saving…" : save === "failed" ? <span className="text-down-ink">Not saved · <button type="button" className="underline" onClick={() => setSavedJson("")}>Retry</button></span> : "Saved";
  const idx = new Map((preview.data?.columns ?? []).map((c, i) => [c.id, i]));
  const firstRow = preview.data?.lines.find((l) => l.kind === "row");
  return (
    <div className="grid gap-section">
      <PageHeader title={`${shownName || template.data.name} · ${v.status === "draft" ? "draft" : "version"} ${v.version}`} crumb={`${v.status === "draft" ? "Draft" : "Version"} ${v.version}`}
        trail={[{ label: "Reports", href: reportsHref(spaceId, "/templates") }, { label: template.data.name, href: reportsHref(spaceId, `/templates/${encodeURIComponent(templateId)}`) }]}
        description={<>{template.data.recon.name} · {readOnly ? (v.status === "waiting" ? "Waiting for approval: read only" : !canEdit ? EDIT_DRAFT_REASON : "Read only") : saveLine}</>}
        actions={readOnly ? undefined : <>
          <Button type="button" variant="ghost" size="sm" disabled={!hist?.past.length} onClick={undo} aria-keyshortcuts="Control+Z">Undo</Button>
          <Button type="button" variant="ghost" size="sm" disabled={!hist?.future.length} onClick={redo} aria-keyshortcuts="Control+Shift+Z">Redo</Button>
          <Button type="button" variant="secondary" onClick={() => void test()}>Test with real data</Button>
          {blocked ? <BlockedButton reason={blocked}>Send report version</BlockedButton>
            : <Button type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void submit()}>{busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Send report version</Button>}
        </>} />
      {v.note && <Notice tone="warn">Sent back: {v.note}</Notice>}
      {sampleId && <Notice tone={sample?.status === "failed" ? "warn" : "progress"} live>
        {line.link ? <a className="font-medium underline" href={reportsApi(spaceId, `/samples/${encodeURIComponent(sampleId)}`)} download>{line.text}</a> : line.text} (kept 24 hours)
      </Notice>}
      <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setDragging((e.active.data.current as DragItem | undefined) ?? null)}
        onDragMove={(e) => setDrop(markOf(e))} onDragOver={(e) => setDrop(markOf(e))} onDragEnd={onDragEnd} onDragCancel={() => { setDragging(null); setDrop(null); }}>
        <div className="grid items-start gap-3 lg:grid-cols-[16rem_minmax(0,1fr)] 2xl:grid-cols-[16rem_minmax(0,1fr)_20rem]">
          <div className="lg:sticky lg:top-3">
            <DataPane dataset={spec.dataset} readOnly={readOnly} fields={fields.data} used={new Set(spec.columns.flatMap((c) => (c.content.kind === "field" ? [c.content.ref] : [])))}
              onDataset={(d) => change((s) => ({ ...s, dataset: d }), `Rows from ${d === "results" ? "results" : d === "items" ? "every item" : "the daily recap"}. Columns on fields that data lacks show empty.`)}
              onAdd={(f) => addField(f)} onAddSpecial={(k) => addSpecial(k)} />
          </div>
          <Panel title="Report" description="The file as it will be, on real rows (customer data masked)."
            actions={<div className="flex flex-wrap items-center gap-2">
              <Segmented label="File format" value={spec.output.format} options={(Object.keys(FORMAT_LABEL) as ReportFormat[]).map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
                onChange={(f) => change((s) => setFormat(s, f))} />
              <Input type="date" aria-label="Preview date" className="h-8 w-40" value={date} onChange={(e) => setDate(e.target.value)} />
              {preview.loading && <Icon icon={SpinnerIcon} className="size-4 text-fg-3 motion-safe:animate-spin" aria-label="Loading the preview" />}
            </div>}>
            <ReportCanvas spec={spec} change={change} readOnly={readOnly} preview={preview} date={date} fields={fields.map} selected={selected} select={select}
              drop={drop} dragging={dragging} onAddField={(f) => addField(f)} />
          </Panel>
          <div className="lg:col-span-2 2xl:sticky 2xl:top-3 2xl:col-span-1">
            <Panel title="Settings" bodyClassName="grid gap-3">
              <InspectorPane spec={spec} selected={selected} select={select} change={change} fields={fields.map} readOnly={readOnly} name={shownName} onName={setName}
                preview={{
                  cell: (id) => { const i = idx.get(id); return i === undefined || !firstRow ? null : firstRow.cells[i] ?? ""; },
                  problem: (id) => preview.data?.problems.find((p) => p.columnId === id)?.message.replace(/^[^:]*: /, "") ?? null,
                }} />
            </Panel>
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging && <span className="inline-flex items-center gap-2 rounded-ctl border border-line bg-card px-3 py-1.5 text-body-sm shadow-overlay">
            <TypeBadge type={dragging.kind === "field" ? dragging.field.type : dragging.kind === "special" ? "formula" : "text"} />
            {dragging.kind === "field" ? dragging.field.label : dragging.label}
          </span>}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
