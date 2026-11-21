"use client";

import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { BlockedButton, Panel, StatusChip } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { APP_TIME_ZONE_LABEL, formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { FailedIcon, SpinnerIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { DateRange } from "@starterkit/ui/lib/date-range";
import type { ReconDto, ReconSpec, ReconVersionDto } from "@starterkit/shared/contracts/recon";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import { recordFields, type SourceSpecLike } from "@starterkit/shared/recon";
import type { SourceKind } from "@starterkit/shared/sources";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { api, errorText } from "@/lib/client/api";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { RECON_KEY, reconDetail } from "@/lib/shared/queries";
import { PassEditor, PlaceError, SettingsEditor, SideEditor } from "./inspector";
import {
  addCurrencyCondition, addPass, carryOverFix, carryOverGates, isCarryOverWarning, tolerancePass, currencyGaps, currencyGapText, daysText, type Fields, filterText, graceText, measureText, moved, movePass,
  insertAt, type Place, placeOf, removePass, restorePass, scheduleText, submitReason,
} from "./spec-model";
import { Connector, DASH, PassRow, type PassRowProps } from "./pass-row";
import type { SortablePasses as SortableList } from "./sortable-passes";
import { ReplayRange } from "./replay-range";
import { saveQueue } from "./save-queue";
import { connectorText, countLine, CURRENCY_DIFFERS, defaultReplay, isLive, passOutcome, projectionText, reasonCount, RUNNING_REASON, runTotals, simView } from "./run-model";
import { MAKER_REASON, reconApi, reconRunHref, STALL_TEXT, useSideSource, useSimulation } from "./use-recons";

const InspectorSheet = dynamic(() => import("./inspector-sheet"), { ssr: false });

/** The draft's autosave as the page header says it (ui-standard §1a: save status lives only in the header line). */
export type SaveState = { status: "saved" | "saving" | "failed"; retry: () => void };
/** How long after the last change the draft saves itself. */
const SAVE_DELAY_MS = 800;
/** "Pass 2, condition 1: …" for the status line: the place and the API's sentence. */
const problemText = (p: Place) =>
  `${p.pass !== undefined ? `Pass ${p.pass}${p.condition !== undefined ? `, condition ${p.condition + 1}` : p.key !== undefined ? `, matching key ${p.key + 1}` : ""}` : p.side !== undefined ? `Side ${p.side === 0 ? "A" : "B"}${p.filter !== undefined ? `, filter ${p.filter + 1}` : ""}` : p.setting}: ${p.text}`;
const KIND: Record<SourceKind, string> = { file_inbox: "File inbox", db_watermark: "Database · watermark", db_snapshot: "Database · snapshot" };

type Selected = { k: "pass"; key: string } | { k: "side"; i: 0 | 1 } | { k: "settings" };

/** A warning or error under the settings strip, with its one-click fix (BUILDER-SPEC "States"). */
function Banner({ tone, children, action }: { tone: "warn" | "error"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-3 py-2.5 text-body-sm",
      tone === "warn" ? "border-degraded-mark bg-degraded-soft text-degraded-ink" : "border-down-mark bg-down-soft text-down-ink")}>
      <Icon icon={tone === "warn" ? WarningIcon : FailedIcon} className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 basis-64">{children}</p>
      {action}
    </div>
  );
}

/** A side card: the side's label, its source and kind, its filters. Selecting it opens the side in the inspector. */
function SideCard({ i, spec, source, fields, selected, onSelect }: {
  i: 0 | 1; spec: ReconSpec; source: SourceDto | undefined; fields: Fields; selected: boolean; onSelect: () => void;
}) {
  const s = spec.sides[i];
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect}
      className={cn("grid min-w-0 content-start gap-1.5 rounded-md border bg-card p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        selected ? "border-fg shadow-sm" : "border-line")}>
      <span className="flex min-w-0 items-baseline gap-2"><span className="text-caption text-fg-3">Side {i === 0 ? "A" : "B"}</span><span className="truncate text-label text-fg">{s.label}</span></span>
      <span className="truncate text-caption text-fg-2">
        {source ? [source.name, KIND[source.kind], source.publishedVersion ? `v${source.publishedVersion}` : "no approved version", source.owner ? `shared from ${source.owner.name}` : null].filter(Boolean).join(" · ") : "Loading the source…"}
      </span>
      <span className="grid gap-0.5 font-mono text-mono text-fg-3 wrap-anywhere">
        {s.filter.length ? s.filter.map((f, j) => <span key={j}>{filterText(f, fields[i])}</span>) : <span>no filter</span>}
        {s.amount_sign === "negate" && <span>amount with the opposite sign</span>}
      </span>
    </button>
  );
}

/**
 * The builder's list view (BUILDER-SPEC, Figma page 03 v1.0.4): simulation bar, settings strip, banners, the two
 * sides and the passes in run order, and the inspector (right from 1280 px, under the passes from 768 px, a bottom
 * sheet below). `editable` = the open draft for a config maker; otherwise the same view, read only (`bar` false: no
 * simulation bar, as on a version's page). Save sends the
 * whole spec (PATCH …/versions/{id}); the API's refusal lands on the place it names, its warnings above the passes.
 */
export function Builder({ spaceId, recon, version, editable, canEdit, bar = true, onSaveState }: {
  spaceId: string; recon: ReconDto; version: ReconVersionDto; editable: boolean; canEdit: boolean; bar?: boolean;
  /** The autosave's state, for the page header's line (Saved / Saving… / Not saved with Retry). */
  onSaveState?: (s: SaveState) => void;
}) {
  const qc = useQueryClient();
  const [spec, setSpec] = useState<ReconSpec>(version.spec);
  const [saved, setSaved] = useState<ReconVersionDto>(version);
  // a pass's stable key (its DOM and focus stay while it moves): p0, p1 … as loaded, the same on the server and in
  // the browser; new passes count on from there
  const [keys, setKeys] = useState<string[]>(() => version.spec.passes.map((_, i) => `p${i}`));
  const keySeq = useRef(version.spec.passes.length);
  // Undo of a removal (no confirmation in an editor that saves itself, ui-standard §1a) puts back only the removed item,
  // into the spec as it is then, found by its pass's stable key; a row's toast goes when its pass is removed.
  const keysNow = useRef(keys);
  useEffect(() => { keysNow.current = keys; });
  const undoSeq = useRef(0);
  const rowToasts = useRef(new Map<string, string[]>());
  const [sel, setSel] = useState<Selected>(() => (keys[0] ? { k: "pass", key: keys[0] } : { k: "side", i: 0 }));
  const [sheet, setSheet] = useState(false);
  const [problem, setProblem] = useState<Place | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // autosave (Captain, builder round 2): the spec saves itself a moment after each change; `savedJson` = the spec as
  // last accepted, `failedJson` = one the API refused (not sent again until it changes), `ourHash` = the hash of our
  // last save, so a refetch with another hash means another tab or person saved meanwhile
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(version.spec));
  const [failedJson, setFailedJson] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // saves in order; Run simulation flushes it so it simulates the spec on screen (save-queue.ts)
  const [queue] = useState(() => saveQueue(JSON.stringify(version.spec)));
  // the save under way (Run simulation waits for it) and the spec as the API last accepted it, read after an await
  const [ourHash, setOurHash] = useState(version.specHash);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const sa = useSideSource(spaceId, spec.sides[0].source_id), sb = useSideSource(spaceId, spec.sides[1].source_id);
  const specA = sa.data?.published?.spec ?? null, specB = sb.data?.published?.spec ?? null;
  const sourceSpecs: [SourceSpecLike | null, SourceSpecLike | null] = [specA, specB];
  const fields: Fields = useMemo(() => [specA ? recordFields(specA) : null, specB ? recordFields(specB) : null], [specA, specB]);
  const json = JSON.stringify(spec);
  const dirty = json !== savedJson;
  const failed = dirty && failedJson === json;
  // the leave guard holds only while a change is waiting, saving or refused
  const guard = useLeaveGuard(editable && dirty);
  const conflict = editable && version.specHash !== ourHash;
  const gaps = currencyGaps(spec, sourceSpecs);
  // the drag order loads only where it can be used (a draft with two passes or more); the cmdk field list with the
  // first draft, so the inspector's first field picker doesn't wait on its chunk
  const [Sortable, setSortable] = useState<typeof SortableList | null>(null);
  const sortable = editable && spec.passes.length > 1;
  useEffect(() => {
    if (!sortable || Sortable) return;
    let on = true;
    void import("./sortable-passes").then((m) => { if (on) setSortable(() => m.SortablePasses); });
    return () => { on = false; };
  }, [sortable, Sortable]);
  useEffect(() => { if (editable) void import("@starterkit/ui/ds/combobox-command"); }, [editable]);
  const inspectorRef = useRef<HTMLDivElement>(null);

  const passIndex = sel.k === "pass" ? keys.indexOf(sel.key) : -1;
  const change = (next: ReconSpec) => { setSpec(next); setProblem(null); setSubmitError(null); };
  /** The toast of a removal whose Undo applies `restore` to the current spec; `passKey` = the pass it belongs to. */
  const offerUndo = (message: string, passKey: string | null, restore: (cur: ReconSpec, at: number) => ReconSpec | null) => {
    const id = `recon-undo-${undoSeq.current++}`;
    if (passKey) rowToasts.current.set(passKey, [...(rowToasts.current.get(passKey) ?? []), id]);
    toast.undo(message, () => {
      const at = passKey ? keysNow.current.indexOf(passKey) : -1;
      if (passKey && at < 0) return;
      setSpec((cur) => restore(cur, at) ?? cur);
      setProblem(null);
    }, { id });
  };
  const focusLater = (id: string) => requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(id)?.focus()));
  const onPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  const select = (s: Selected) => {
    setSel(s);
    if (onPhone()) setSheet(true);
    else requestAnimationFrame(() => { const h = inspectorRef.current?.querySelector<HTMLElement>("h2"); h?.setAttribute("tabindex", "-1"); h?.focus(); });
  };
  /** Moves a pass; `announce` for Alt+↑/↓ and Move earlier/later (a drop is announced by dnd-kit). */
  const move = (from: number, to: number, announce = true) => {
    if (to < 0 || to >= keys.length || from === to) return;
    change(movePass(spec, from, to));
    setKeys(moved(keys, from, to));
    if (announce) setSaid(`Moved to pass ${to + 1}`);
  };
  const onPassKey = (i: number, key: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!editable || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    move(i, i + (e.key === "ArrowUp" ? -1 : 1));
    focusLater(`pass-${key}`);
  };

  /**
   * Sends the spec as it is now; `explicit` (Retry) also opens and focuses the place a refusal names. Answers whether
   * the API took it; while a save is under way, that save's answer.
   */
  function save(explicit = false): Promise<boolean> {
    return queue.save(json, () => send(explicit).finally(() => setSaving(false)));
  }
  async function send(explicit: boolean): Promise<boolean> {
    const sent = spec, sentJson = JSON.stringify(sent);
    setSaving(true);
    try {
      const v = await api<ReconVersionDto>(reconApi(spaceId, recon.id, `/versions/${encodeURIComponent(saved.id)}`), { method: "PATCH", body: JSON.stringify({ spec: sent }) });
      setOurHash(v.specHash);
      setSaved(v);
      setSavedJson(sentJson);
      setFailedJson(null);
      setProblem(null);
      qc.setQueryData(reconDetail(spaceId, recon.id).key, (r: ReconDto | undefined) => (r ? { ...r, draft: v } : r));
      void qc.invalidateQueries({ queryKey: RECON_KEY });
      return true;
    } catch (e) {
      const place = placeOf(errorText(e));
      setProblem(place);
      setFailedJson(sentJson);
      if (explicit) {
        if (place.pass !== undefined && keys[place.pass - 1]) {
          setSel({ k: "pass", key: keys[place.pass - 1]! });
          const i = place.pass - 1;
          focusLater(place.condition !== undefined ? `rp-${i}-cond-${place.condition}-a` : place.key !== undefined ? `rp-${i}-key-${place.key}-a` : `rp-${i}-name`);
        } else if (place.side !== undefined) {
          setSel({ k: "side", i: place.side });
          focusLater(`rs-${place.side}-label`);
        } else if (place.setting) {
          setSel({ k: "settings" });
          focusLater({ Grace: "rs-grace", "Carry over": "rs-carry", "Close time": "rs-close" }[place.setting] ?? "rs-at");
        }
        if (onPhone() && (place.pass !== undefined || place.side !== undefined || place.setting)) setSheet(true);
      }
      return false;
    }
  }
  /** The spec of this render, saved: waits for a save under way, then sends what it didn't include. */
  async function flush(): Promise<boolean> {
    return queue.flush(json, () => send(false).finally(() => setSaving(false)));
  }
  // a moment after the last change; never again for a spec the API refused until it changes
  useEffect(() => {
    if (!editable || !dirty || saving || failedJson === json) return;
    const t = setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [json, savedJson, failedJson, saving, editable]); // eslint-disable-line react-hooks/exhaustive-deps -- save reads the spec of this render
  /** Another tab or person saved this draft: take their version (our unsaved change, if any, is dropped). */
  const takeTheirs = () => {
    setOurHash(version.specHash);
    setSpec(version.spec);
    setSaved(version);
    setSavedJson(JSON.stringify(version.spec));
    queue.reset(JSON.stringify(version.spec));
    setFailedJson(null);
    setProblem(null);
    setKeys(version.spec.passes.map(() => `p${keySeq.current++}`));
  };

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      setSaved(await api<ReconVersionDto>(reconApi(spaceId, recon.id, `/versions/${encodeURIComponent(saved.id)}/submit`), { method: "POST", body: "{}" }));
      toast(`Draft v${saved.version} of ${recon.name} sent for approval. A config checker approves or rejects it.`);
      await qc.invalidateQueries({ queryKey: RECON_KEY });
    } catch (e) {
      setSubmitError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  const simOn = bar && saved.status === "draft";
  const simulation = useSimulation(spaceId, recon.id, saved.id, simOn);
  const live = isLive(simulation.run);
  const [range, setRange] = useState<DateRange>(() => simulation.run ? { from: simulation.run.from, to: simulation.run.to } : defaultReplay());
  const [starting, setStarting] = useState(false);
  // a simulation that ended marks the draft simulated (the recon is read again): take its simulatedHash for the same spec
  if (version.id === saved.id && version.specHash === saved.specHash && version.simulatedHash !== saved.simulatedHash) setSaved({ ...saved, simulatedHash: version.simulatedHash });
  const sim = simView(saved, simulation.run, simulation.shown, dirty);
  const totals = sim.counts ? runTotals(sim.counts.counters, spec) : null;
  async function simulate() {
    setStarting(true);
    try {
      // the API simulates the saved draft: the last change first
      if (!(await flush())) return;
      await simulation.start(range);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setStarting(false);
    }
  }
  const blocked = !canEdit ? MAKER_REASON : !dirty && (live || starting) ? RUNNING_REASON : submitReason(saved, { dirty, failed, passes: spec.passes.length, gaps });
  const simBlocked = !canEdit ? MAKER_REASON : failed ? "The draft isn't saved. Retry the save, then run the simulation." : null;
  // the header's save line: a stable Retry that saves the spec of the latest render
  const retry = useRef(() => {});
  useEffect(() => { retry.current = () => void save(true); });
  const saveStatus = failed ? "failed" : dirty || saving ? "saving" : "saved";
  useEffect(() => { if (editable) onSaveState?.({ status: saveStatus, retry: () => retry.current() }); }, [saveStatus, editable, onSaveState]);
  const placed = problem && (problem.pass !== undefined || problem.side !== undefined || problem.setting) ? problem : null;
  const gates = carryOverGates(spec);
  const notes = (no: number) => saved.warnings.filter((w) => tolerancePass(w) === no);
  const pageWarnings = saved.warnings.filter((w) => !isCarryOverWarning(w) && tolerancePass(w) === null);
  const title = sel.k === "settings" ? "Settings" : sel.k === "side" ? `Side ${sel.i === 0 ? "A" : "B"}` : passIndex >= 0 ? `Pass ${passIndex + 1} of ${spec.passes.length}` : "Pass";
  const sourceOf = (i: 0 | 1) => (i === 0 ? sa.data : sb.data);
  const editor = sel.k === "settings"
    ? <SettingsEditor spec={spec} place={placed?.setting ? placed : null} onChange={change} />
    : sel.k === "side"
      ? <SideEditor spec={spec} i={sel.i} fields={fields} sourceName={sourceOf(sel.i)?.name ?? "Loading…"} place={placed?.side === sel.i ? placed : null}
        onChange={(s) => change({ ...spec, sides: sel.i === 0 ? [s, spec.sides[1]] : [spec.sides[0], s] })}
        onRemoved={(message, restore) => offerUndo(message, null, (cur) => restore(cur))} />
      : passIndex >= 0
        ? <PassEditor spec={spec} i={passIndex} fields={fields} place={placed?.pass === passIndex + 1 ? placed : null}
          onChange={(p) => change({ ...spec, passes: spec.passes.map((x, j) => (j === passIndex ? p : x)) })}
          onMove={(dir) => { move(passIndex, passIndex + dir); focusLater(`pass-${keys[passIndex]}`); }}
          onRemoved={(message, restore) => offerUndo(message, keys[passIndex]!, restore)}
          onRemove={() => {
            const pass = spec.passes[passIndex]!, key = keys[passIndex]!, at = passIndex;
            const rest = keys.filter((_, j) => j !== passIndex);
            change(removePass(spec, passIndex));
            setKeys(rest);
            setSel(rest[0] ? { k: "pass", key: rest[Math.min(passIndex, rest.length - 1)]! } : { k: "side", i: 0 });
            setSheet(false);
            // its rows' Undo can't apply any more: their toasts go
            for (const id of rowToasts.current.get(key) ?? []) toast.dismiss(id);
            rowToasts.current.delete(key);
            toast.undo(`Removed pass ${at + 1}${pass.name ? ` (${pass.name})` : ""}.`, () => {
              setSpec((cur) => restorePass(cur, pass, at));
              setKeys((cur) => insertAt(cur, at, key));
              setSel({ k: "pass", key });
              setProblem(null);
            }, { id: `recon-undo-${undoSeq.current++}` });
          }} />
        : null;
  // read only while it is sent for approval (an autosave never replaces what is being typed: it only records the save)
  const body = editor && <fieldset disabled={!editable || submitting} className="contents">{editor}</fieldset>;
  const counters = simOn ? sim.counts?.counters : undefined;
  // what day close would do with the simulation's waiting items (its projection); currency differs has its own card
  const projection = counters ? (simulation.shown?.projection ?? null) : null;
  const currency = projection ? reasonCount(projection, CURRENCY_DIFFERS, [spec.sides[0].label, spec.sides[1].label]) : null;
  const rows: PassRowProps[] = spec.passes.map((p, i) => ({
    id: keys[i]!, pass: p, fields, editable, selected: sel.k === "pass" && sel.key === keys[i], notes: notes(p.no),
    sim: counters ? { outcome: passOutcome(counters, spec, p), connector: connectorText(counters, spec, i + 1), dim: sim.dim } : undefined,
    onSelect: () => select({ k: "pass", key: keys[i]! }), onKey: onPassKey(i, keys[i]!),
  }));
  const onInspectorKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || sel.k !== "pass" || (e.target as HTMLElement).closest("[data-slot=popover-content],[role=dialog]")) return;
    document.getElementById(`pass-${sel.key}`)?.focus();
  };

  return (
    <div className="grid gap-section">
      <p aria-live="polite" className="sr-only">{said}</p>
      <span role="status" className="sr-only">{editable && failed ? "Not saved" : ""}</span>
      {failed && problem && <p role="alert" className="text-body-sm text-down-ink">{placed ? problemText(placed) : problem.text}</p>}
      {simOn && (
        <section aria-label="Simulation" className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-line bg-card p-4 shadow-xs">
          <StatusChip health={sim.chip.health} label={sim.chip.label} />
          <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
            {/* the live region is the state line only: the counts change with every poll */}
            <span role="status" className="text-body-sm text-fg">{sim.line}{simulation.stalled ? ` · ${STALL_TEXT}` : ""}</span>
            <span className={cn("text-caption text-fg-3 tabular", sim.dim && "opacity-60")}>
              {totals ? countLine(totals, [spec.sides[0].label, spec.sides[1].label]) : `Matched ${DASH} · suggested ${DASH} · duplicate ${DASH} · waiting ${DASH} · match rate ${DASH}`}
              {simulation.shown && <> · <Link href={reconRunHref(spaceId, recon.id, simulation.shown.id)} className="text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary">Show results</Link></>}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 max-md:w-full max-md:*:w-full">
            {editable && <ReplayRange value={range} onChange={setRange} disabled={live || starting} />}
            <BlockedButton variant="secondary" reason={simBlocked} disabled={live || starting} aria-busy={live || starting || undefined} onClick={() => void simulate()}>
              {(live || starting) && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Run simulation
            </BlockedButton>
            <BlockedButton reason={blocked} disabled={submitting} aria-busy={submitting || undefined} onClick={() => void submit()}>
              {submitting && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Submit for approval
            </BlockedButton>
          </div>
          {submitError && <p role="alert" className="basis-full text-body-sm text-down-ink">{submitError}</p>}
        </section>
      )}

      <section aria-label="Settings" className="flex flex-wrap items-end gap-x-8 gap-y-3 rounded-lg border border-line bg-tray px-4 py-3">
        <dl className="flex flex-1 flex-wrap gap-x-8 gap-y-2">
          {[["Schedule", scheduleText(spec.schedule)], ["Grace", graceText(spec.grace_minutes)], ["Carry over", daysText(spec.carry_over_days)],
            ["Day closes", `${spec.close_at} ${APP_TIME_ZONE_LABEL}`], ["Measure", measureText(spec, fields)]].map(([k, v]) => (
            <div key={k} className="grid gap-0.5"><dt className="text-caption text-fg-3">{k}</dt><dd className="text-body-sm text-fg">{v}</dd></div>
          ))}
        </dl>
        <Button type="button" variant="ghost" onClick={() => select({ k: "settings" })}>{editable ? "Edit settings" : "Show settings"}</Button>
      </section>

      {conflict && (
        <Banner tone="warn" action={<Button type="button" variant="secondary" size="sm" onClick={takeTheirs}>Load the saved draft</Button>}>
          This draft was saved from another tab or by someone else. Your next change replaces that save.
        </Banner>
      )}
      {editable && gaps.length > 0 && (
        <Banner tone="error" action={<Button type="button" variant="secondary" size="sm" disabled={!fields[0]?.has("currency") || !fields[1]?.has("currency")}
          onClick={() => change(addCurrencyCondition(spec, gaps))}>Add currency condition</Button>}>{currencyGapText(gaps, fields)}</Banner>
      )}
      {[...gates, ...pageWarnings].map((w) => {
        const fix = editable ? carryOverFix(w) : null;
        return (
          <Banner key={w} tone="warn" action={fix !== null && spec.carry_over_days < fix
            ? <Button type="button" variant="secondary" size="sm" onClick={() => change({ ...spec, carry_over_days: fix })}>Set carry over to {daysText(fix)}</Button> : undefined}>{w}</Banner>
        );
      })}

      <div className="grid items-start gap-section xl:grid-cols-[minmax(0,1fr)_21.25rem]">
        <Panel title="Passes in run order" description={editable && spec.passes.length > 1 ? "Drag a pass or press Alt+↑/↓ to move it" : undefined}>
          <div className="grid gap-0">
            <div className="grid gap-3 md:grid-cols-2">
              {([0, 1] as const).map((i) => <SideCard key={i} i={i} spec={spec} source={sourceOf(i)} fields={fields} selected={sel.k === "side" && sel.i === i} onSelect={() => select({ k: "side", i })} />)}
            </div>
            {placed?.side !== undefined && <div className="pt-2"><PlaceError text={`Side ${placed.side === 0 ? "A" : "B"}: ${placed.text}`} /></div>}
            <Connector text={counters ? connectorText(counters, spec, 0) : undefined} dim={sim.dim} />
            {spec.passes.length ? (
              Sortable && sortable ? <Sortable rows={rows} onMove={(from, to) => move(from, to, false)} />
                : <ol aria-label="Passes in run order" className="grid">{rows.map((p) => <PassRow key={p.id} {...p} />)}</ol>
            ) : <p className="rounded-md border border-dashed border-line p-4 text-body-sm text-fg-2">No passes yet.</p>}
            {editable && (
              <span className="pb-3">
                <BlockedButton type="button" variant="secondary" reason={spec.passes.length >= 20 ? "A recon has at most 20 passes." : !fields[0] || !fields[1] ? "The sides' sources are still loading." : null}
                  onClick={() => { const k = `p${keySeq.current++}`; change(addPass(spec, fields)); setKeys([...keys, k]); select({ k: "pass", key: k }); }}>Add pass</BlockedButton>
              </span>
            )}
            <div className="grid gap-3 text-caption text-fg-3 md:grid-cols-2">
              <div className="grid gap-1 border-l-2 border-line pl-3">
                <span className="text-label text-fg-2">Waiting · during the day{counters ? ` · ${formatNumber(counters.open.a)} ${spec.sides[0].label} · ${formatNumber(counters.open.b)} ${spec.sides[1].label}` : ""}</span>
                <span>Waits {graceText(spec.grace_minutes).toLowerCase()} after the other side is complete · carry over {daysText(spec.carry_over_days)}</span>
              </div>
              <div className="grid gap-1 border-l-2 border-line pl-3">
                <span className="text-label text-fg-2">Break · at day close</span>
                <span className={cn("tabular", sim.dim && "opacity-60")}>Items still open at {spec.close_at} {APP_TIME_ZONE_LABEL} become breaks · {projection ? projectionText(projection, [spec.sides[0].label, spec.sides[1].label], [CURRENCY_DIFFERS]) || "none" : DASH}</span>
              </div>
              {currency && (
                <div className={cn("grid gap-1 border-l-2 border-down-mark pl-3", sim.dim && "opacity-60")}>
                  <span className="text-label text-down-ink">{CURRENCY_DIFFERS}</span>
                  <span className="tabular">{currency} · break at day close</span>
                </div>
              )}
            </div>
          </div>
        </Panel>

        <div ref={inspectorRef} onKeyDown={onInspectorKey} className="max-md:hidden">
          <Panel title={title}>{!sheet && body}</Panel>
        </div>
      </div>

      {sheet && body && <InspectorSheet title={title} onClose={() => { setSheet(false); if (sel.k === "pass") focusLater(`pass-${sel.key}`); }}>{body}</InspectorSheet>}
      {guard.leaving && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) guard.stay(); }} auditFields={false} reasons={[]} destructive title="Leave without saving"
          onCloseAutoFocus={(e) => { e.preventDefault(); guard.restoreFocus(); }} description={failed ? `The last change wasn't saved: ${problem?.text ?? "the save failed"}` : `Draft v${saved.version} is still saving the last change.`}
          impact={["Changes not saved yet are discarded."]} actionLabel="Leave page" onConfirm={async () => guard.leave()} />
      )}
    </div>
  );
}
