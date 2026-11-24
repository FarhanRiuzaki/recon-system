"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockedButton, FormFooter, Panel, Segmented, StatusChip, Wizard } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { APP_TIME_ZONE_LABEL, formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, ChevronDownIcon, EditIcon, FailedIcon, SpinnerIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@starterkit/ui/ui/dropdown-menu";
import { toast } from "@starterkit/ui/ui/toast";
import type { DateRange } from "@starterkit/ui/lib/date-range";
import type { ReconDto, ReconRunItemDto, ReconSpec, ReconVersionDto } from "@starterkit/shared/contracts/recon";
import type { Page } from "@starterkit/shared/contracts/common";
import { recordFields, type SourceSpecLike } from "@starterkit/shared/recon";
import { approvalNotice, stepWarnings } from "./approval-model";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { SortableList } from "@/components/sortable-list";
import { api, errorText } from "@/lib/client/api";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { APPROVALS_KEY, ENGINE_KEY, RECON_KEY } from "@/lib/shared/queries";
import { reconDetail } from "@/lib/shared/queries-recon";
import { PassEditor, SettingsEditor, SideEditor } from "./inspector";
import {
  addCurrencyCondition, addTemplatePass, carryText, directionOf, PASS_TEMPLATES, SETUP_STEPS, type SetupStep, stepReasons, passNeeds, type PassTemplate, templateReason, incompleteField, carryOverFix, carryOverGates, currencyGaps, currencyGapText, daysText, type Fields, graceText, moved, movePass,
  insertAt, type Place, placeOf, removePass, restorePass, submitReason,
} from "./spec-model";
import { DirectionPicker } from "./direction-picker";
import { DASH, PassRow, type PassRowProps } from "./pass-row";
import { ReplayRange } from "./replay-range";
import { CanvasLoader } from "./canvas-loader";
// step 4 loads when it opens (first-load budget, DEC-040)
const ApprovalStep = dynamic(() => import("./approval-step").then((m) => m.ApprovalStep), { ssr: false, loading: () => <Panel><div className="h-40" /></Panel> });
import { SpecView } from "./spec-view";
import { saveQueue } from "./save-queue";
import { amountText, connectorText, countLine, CURRENCY_DIFFERS, defaultReplay, isLive, rangeText, passOutcome, projectionText, reasonCount, RUNNING_REASON, runTotals, simView, type SimView } from "./run-model";
import { MAKER_REASON, reconApi, reconRunHref, STALL_TEXT, useReplayDefault, useSideSource, useSimulation } from "./use-recons";

const InspectorSheet = dynamic(() => import("./inspector-sheet"), { ssr: false });

/** The simulation bar's chip (run-model `simView`). */
const SimChip = ({ chip }: { chip: SimView["chip"] }) => <StatusChip health={chip.health} label={chip.label} />;

/** The builder's copy of an unsaved spec (rule 12), or null: `base` = the server spec hash it was made over. */
function readKept(key: string): { base: string; spec: ReconSpec } | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as { base: string; spec: ReconSpec }) : null; } catch { return null; }
}

/** The draft's autosave as the page header says it (ui-standard §1a: save status lives only in the header line). */
export type SaveState = { status: "saved" | "saving" | "failed" | "incomplete"; retry: () => void };
/** How long after the last change the draft saves itself. */
const SAVE_DELAY_MS = 800;
/** "Pass 2, condition 1: …" for the status line: the place and the API's sentence. */
const problemText = (p: Place) =>
  `${p.pass !== undefined ? `Pass ${p.pass}${p.condition !== undefined ? `, condition ${p.condition + 1}` : p.key !== undefined ? `, matching key ${p.key + 1}` : ""}` : p.side !== undefined ? `Side ${p.side === 0 ? "A" : "B"}${p.filter !== undefined ? `, filter ${p.filter + 1}` : ""}` : p.setting}: ${p.text}`;

type Selected = { k: "pass"; key: string } | { k: "side"; i: 0 | 1 } | { k: "settings" };
/** The setup's five steps (owner, 22 Nov): Sources, Matching, Schedule, Test, Review and submit. */
export type WizardStep = SetupStep;

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

/**
 * What pass `passNo` paired in simulation `runId`, one example (owner, 22 Nov: see what a pass does): its reference and
 * both sides' amounts. Its first page of items, cached per run; nothing while there are none.
 */
function PassExample({ spaceId, configId, runId, passNo }: { spaceId: string; configId: string; runId: string; passNo: number }) {
  const q = useQuery({
    queryKey: [...ENGINE_KEY, "pass-example", spaceId, runId, passNo],
    queryFn: () => api<Page<ReconRunItemDto>>(reconApi(spaceId, configId, `/runs/${encodeURIComponent(runId)}/items?pass=${passNo}&pageSize=15`)),
    staleTime: Infinity,
  });
  const g = q.data?.items.find((x) => x.group && x.group.members.length > 1)?.group;
  if (!g) return null;
  const a = g.members.find((m) => m.side === "a"), b = g.members.find((m) => m.side === "b");
  return (
    <span className="grid gap-0.5 border-t border-line pt-2">
      <span className="text-caption text-fg-3">For example</span>
      <span className="truncate font-mono text-caption text-fg-2" title={a?.extRef ?? b?.extRef ?? undefined}>{a?.extRef ?? b?.extRef ?? "—"}</span>
      <span className="text-caption text-fg-2 tabular">{amountText(a?.amountMinor ?? null, a?.currency ?? null)} ↔ {amountText(b?.amountMinor ?? null, b?.currency ?? null)}</span>
    </span>
  );
}

/** Add pass (owner, 22 Nov): a ready pass to start from, each saying what it does; one a side can't take says why. */
function AddPassMenu({ fields, reason, onAdd }: { fields: Fields; reason: string | null; onAdd: (t: PassTemplate) => void }) {
  if (reason) return <BlockedButton type="button" variant="create" reason={reason}><Icon icon={AddIcon} />Add pass</BlockedButton>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="create"><Icon icon={AddIcon} />Add pass<Icon icon={ChevronDownIcon} /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {PASS_TEMPLATES.map((t) => {
          const why = templateReason(t.id, fields);
          return (
            <DropdownMenuItem key={t.id} disabled={!!why} onSelect={() => onAdd(t.id)} className="data-[disabled]:opacity-100">
              <span className="grid min-w-0">
                <span className="in-data-[disabled]:opacity-50">{t.label}</span>
                <span className="text-caption text-fg-3">{why ?? t.hint}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The builder's list view (BUILDER-SPEC, Figma page 03 v1.0.4): simulation bar, settings strip, banners, the two
 * sides and the passes in run order, and the inspector (right from 1280 px, under the passes from 768 px, a bottom
 * sheet below). `editable` = the open draft for a config maker; otherwise the same view, read only (`bar` false: no
 * simulation bar, as on a version's page). Save sends the
 * whole spec (PATCH …/versions/{id}); the API's refusal lands on the place it names, its warnings above the passes.
 */
export function Builder({ spaceId, recon, version, editable, canEdit, step, reached, onStep, exitHref, onSubmitted, onSaveState }: {
  spaceId: string; recon: ReconDto; version: ReconVersionDto; editable: boolean; canEdit: boolean;
  /** The step on screen and the furthest one reached (a draft of a live recon opens on Review: every step reached). */
  step: WizardStep; reached: WizardStep; onStep: (n: WizardStep) => void;
  /** Where Save and close goes (the recon's page); the draft stays saved. */
  exitHref: string; onSubmitted: () => void;
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
  // a field still being filled in (save-queue waits; Run simulation and Submit say what to fill in)
  const incomplete = incompleteField(spec);
  // a schedule time typed that doesn't read as a time (by field id): never in the spec, so it holds step 3 and the leave
  const [clockBad, setClockBad] = useState<Record<string, string>>({});
  const onClockProblem = useCallback((id: string, p: string | null) => setClockBad((x) => {
    if (p) return x[id] === p ? x : { ...x, [id]: p };
    if (!(id in x)) return x;
    const { [id]: _gone, ...rest } = x;
    return rest;
  }), []);
  const clockText = Object.values(clockBad)[0] ?? null;
  // the leave guard holds only while a change is waiting, saving or refused, or a typed time isn't one
  const guard = useLeaveGuard(editable && (dirty || !!clockText));
  // Never lose an edit (ux-form-rules rule 12): a change the API hasn't taken yet (waiting, still being filled in,
  // or refused) is kept in the browser per draft version, over the hash it was made from, and comes back on the next
  // open while the server's draft is still that one; a saved spec drops the copy.
  const keptKey = `recon:builder-draft:${version.id}`;
  useEffect(() => {
    const k = readKept(keptKey);
    if (!k || k.base !== version.specHash || JSON.stringify(k.spec) === JSON.stringify(version.spec)) return;
    // the browser's copy is only readable after mount (no localStorage in the server render): one restore, once
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSpec(k.spec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!editable) return;
    try {
      if (dirty) localStorage.setItem(keptKey, JSON.stringify({ base: ourHash, spec }));
      else localStorage.removeItem(keptKey);
    } catch { /* not kept */ }
    // the spec is compared by its JSON
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json, dirty, editable, ourHash, keptKey]);
  const conflict = editable && version.specHash !== ourHash;
  const gaps = currencyGaps(spec, sourceSpecs);
  // the cmdk field list loads with the first draft, so the inspector's first field picker doesn't wait on its chunk
  useEffect(() => { if (editable) void import("@starterkit/ui/ds/combobox-command"); }, [editable]);

  const passIndex = sel.k === "pass" ? keys.indexOf(sel.key) : -1;
  // an unfinished approval rule (Approval step) holds the step and the submit until it is finished or removed
  const [approvalOpen, setApprovalOpen] = useState(false);
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
  // List or canvas (DEC-041): the same passes and actions; the view is in the URL (?view=canvas), a phone shows the list.
  // The canvas takes the panel's full width (beside the inspector its text would shrink below reading size), so a
  // node opens the inspector in the sheet, as on a phone; closing it returns to the node
  const sp = useSearchParams(), pathname = usePathname();
  const view: "list" | "canvas" = sp.get("view") === "canvas" ? "canvas" : "list";
  const setView = (v: "list" | "canvas") => {
    const next = new URLSearchParams(window.location.search);
    if (v === "canvas") next.set("view", "canvas"); else next.delete("view");
    window.history.replaceState(null, "", next.size ? `${pathname}?${next}` : pathname);
  };
  const focusLater = (id: string) => requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(id)?.focus()));
  const onPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  // a pass opens in the editor dialog (the step's page stays the list); a side and the schedule are edited on their own steps
  const select = (s: Selected) => { setSel(s); setSheet(true); };
  /** Moves a pass; `announce` for Alt+↑/↓ and Move earlier/later (a drag or the grip's keyboard is announced by SortableList). */
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
    // never for a spec still being filled in (an empty tolerance row): the API would refuse it; its field says why
    if (!editable || !dirty || saving || failedJson === json || incomplete) return;
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
      await Promise.all([qc.invalidateQueries({ queryKey: RECON_KEY }), qc.invalidateQueries({ queryKey: APPROVALS_KEY })]);
      onSubmitted();
    } catch (e) {
      setSubmitError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  const simOn = saved.status === "draft";
  const simulation = useSimulation(spaceId, recon.id, saved.id, simOn);
  const live = isLive(simulation.run);
  // the dates to replay: what the maker picked, else the last simulation's, else a date both sides have records on
  // (owner, 22 Nov: a default without data reads as a broken simulation), else yesterday
  const [picked, setRange] = useState<DateRange | null>(null);
  const replay = useReplayDefault(spaceId, spec);
  const suggested = replay.suggested;
  const range: DateRange = picked ?? (simulation.run ? { from: simulation.run.from, to: simulation.run.to } : suggested ?? defaultReplay());
  const gap = replay.gap(range);
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
  const blocked = !canEdit ? MAKER_REASON : incomplete ?? (!dirty && (live || starting) ? RUNNING_REASON : submitReason(saved, { dirty, failed, passes: spec.passes.length, gaps }));
  const simBlocked = !canEdit ? MAKER_REASON : incomplete ?? (failed ? "The draft isn't saved. Retry the save, then run the simulation." : null);
  // the header's save line: a stable Retry that saves the spec of the latest render
  const retry = useRef(() => {});
  useEffect(() => { retry.current = () => void save(true); });
  const saveStatus = failed ? "failed" : saving ? "saving" : dirty && incomplete ? "incomplete" : dirty ? "saving" : "saved";
  useEffect(() => { if (editable) onSaveState?.({ status: saveStatus, retry: () => retry.current() }); }, [saveStatus, editable, onSaveState]);
  const placed = problem && (problem.pass !== undefined || problem.side !== undefined || problem.setting) ? problem : null;
  const gates = carryOverGates(spec);
  const warned = stepWarnings(saved.warnings);
  const notes = warned.pass;
  const title = sel.k === "settings" ? "Settings" : sel.k === "side" ? `Side ${sel.i === 0 ? "A" : "B"}` : passIndex >= 0 ? `Pass ${passIndex + 1} of ${spec.passes.length}` : "Pass";
  const sourceOf = (i: 0 | 1) => (i === 0 ? sa.data : sb.data);
  const editor = sel.k === "settings"
    ? <SettingsEditor spec={spec} place={placed?.setting ? placed : null} onChange={change} onClockProblem={onClockProblem} />
    : sel.k === "side"
      ? <SideEditor spec={spec} i={sel.i} fields={fields} sourceName={sourceOf(sel.i)?.name ?? "Loading…"} place={placed?.side === sel.i ? placed : null}
        onChange={(s) => change({ ...spec, sides: sel.i === 0 ? [s, spec.sides[1]] : [spec.sides[0], s] })}
        onRemoved={(message, restore) => offerUndo(message, null, (cur) => restore(cur))} />
      : passIndex >= 0
        ? <PassEditor spec={spec} i={passIndex} fields={fields} place={placed?.pass === passIndex + 1 ? placed : null}
          onChange={(p) => change({ ...spec, passes: spec.passes.map((x, j) => (j === passIndex ? p : x)) })}
          onMove={(dir) => { move(passIndex, passIndex + dir); focusLater(`pass-${keys[passIndex]}`); }}
          onRemoved={(message, restore) => offerUndo(message, keys[passIndex]!, restore)}
          onRemove={() => removePassAt(passIndex)} />
        : null;
  // read only while it is sent for approval (an autosave never replaces what is being typed: it only records the save)
  const body = editor && <fieldset disabled={!editable || submitting} className="contents">{editor}</fieldset>;
  const counters = simOn ? sim.counts?.counters : undefined;
  // what day close would do with the simulation's waiting items (its projection); currency differs has its own card
  const projection = counters ? (simulation.shown?.projection ?? null) : null;
  const currency = projection ? reasonCount(projection, CURRENCY_DIFFERS, [spec.sides[0].label, spec.sides[1].label]) : null;
  const rows: PassRowProps[] = spec.passes.map((p, i) => ({
    id: keys[i]!, pass: p, fields, editable, selected: sheet && sel.k === "pass" && sel.key === keys[i], notes: notes(p.no),
    sim: counters ? { outcome: passOutcome(counters, spec, p), connector: connectorText(counters, spec, i + 1), dim: sim.dim } : undefined,
    onSelect: () => select({ k: "pass", key: keys[i]! }), onKey: onPassKey(i, keys[i]!), onRemove: editable ? () => removePassAt(i) : undefined,
    needs: editable ? passNeeds(spec, i, gaps, placed?.pass === i + 1 ? placed.text : null) : [],
    example: simOn && simulation.shown && !sim.dim ? <PassExample spaceId={spaceId} configId={recon.id} runId={simulation.shown.id} passNo={p.no} /> : undefined,
  }));
  const selectedId = sel.k === "side" ? (sel.i === 0 ? "side-a" : "side-b") : sel.k === "pass" ? sel.key : null;
  const focusNode = (id: string) => requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.focus()));
  const onCanvasMove = (from: number, to: number, byKey: boolean) => {
    const key = keys[from]!;
    move(from, to, true);
    if (byKey) focusNode(key);
  };
  /** Removes pass `at` (from its card or the inspector), with Undo; the selection moves to the pass now in its place. */
  function removePassAt(at: number) {
    const pass = spec.passes[at]!, key = keys[at]!;
    const rest = keys.filter((_, j) => j !== at);
    change(removePass(spec, at));
    setKeys(rest);
    if (sel.k !== "pass" || sel.key === key) setSel(rest[0] ? { k: "pass", key: rest[Math.min(at, rest.length - 1)]! } : { k: "side", i: 0 });
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
  }
  const onInspectorKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || sel.k !== "pass" || (e.target as HTMLElement).closest("[data-slot=popover-content],[role=dialog]")) return;
    document.getElementById(`pass-${sel.key}`)?.focus();
  };

  // ---- the steps (owner, 22 Nov: one flow, the user knows where to start and what comes next) ----
  const simulated: "none" | "stale" | "current" = saved.simulatedHash === null ? "none" : saved.simulatedHash !== saved.matchingHash || dirty ? "stale" : "current";
  const why = stepReasons({
    loaded: !!fields[0] && !!fields[1], sideProblem: placed?.side !== undefined ? `Side ${placed.side === 0 ? "A" : "B"}: ${placed.text}` : null,
    passes: spec.passes.length, needs: spec.passes.map((_, j) => passNeeds(spec, j, gaps, placed?.pass === j + 1 ? placed.text : null)), incomplete,
    settingProblem: clockText ?? (placed?.setting ? `${placed.setting}: ${placed.text}` : null), simulation: simulated, running: live || starting, submit: blocked,
    approval: approvalOpen ? "A rule is unfinished: name it, complete its conditions and pick its workflow, or remove it." : null,
  });
  const STEP_LABEL = SETUP_STEPS;
  const wizardSteps = ([1, 2, 3, 4, 5, 6] as const).map((n) => ({
    id: String(n), label: STEP_LABEL[n],
    status: (n === step ? "current" : n === 6 ? "todo" : n < step || reached >= n ? (why[n] ? "error" : "done") : "todo") as "current" | "done" | "error" | "todo",
    // a test over dates without a record ran but tested nothing: the rail says so, not a plain Complete (S5)
    ...(n === 5 && n !== step && "health" in sim.chip && sim.chip.label === "No records" && simulation.shown ? { description: `No records on ${rangeText(simulation.shown.from, simulation.shown.to)}` } : {}),
  }));
  const go = (n: WizardStep) => { setSheet(false); onStep(n); };
  const passList = (readOnly: boolean) => (
    spec.passes.length ? (
      !readOnly ? (
        <SortableList items={rows} getKey={(r) => r.id} noun="Pass" label="Passes in run order" disabled={!editable} onReorder={(_, from, to) => move(from, to, false)}
          renderItem={(r, { handle, dragging }) => <PassRow {...r} results={false} handle={handle} dragging={dragging} />} />
      ) : <ol aria-label="Passes in run order" className="grid">{rows.map((p) => <li key={p.id}><PassRow {...p} editable={false} selected={false} onSelect={() => {}} onRemove={undefined} needs={[]} /></li>)}</ol>
    ) : null
  );
  const addPass = (t: PassTemplate) => { const k = `p${keySeq.current++}`; change(addTemplatePass(spec, fields, t)); setKeys([...keys, k]); select({ k: "pass", key: k }); };
  const passLimit = spec.passes.length >= 20 ? "A recon has at most 20 passes." : !fields[0] || !fields[1] ? "The sides' sources are still loading." : null;

  return (
    <Wizard title="Setup progress" steps={wizardSteps}>
      <form noValidate aria-label="Recon setup" className="grid gap-section"
        onSubmit={(e) => { e.preventDefault(); if (why[step] === null) { if (step === 6) void submit(); else go((step + 1) as WizardStep); } }}>
        <h2 className="sr-only">Step {step} of 6 · {STEP_LABEL[step]}</h2>
        <p aria-live="polite" className="sr-only">{said}</p>
        <span role="status" className="sr-only">{editable && failed ? "Not saved" : ""}</span>
        {failed && problem && <p role="alert" className="text-body-sm text-down-ink">{placed ? problemText(placed) : problem.text}</p>}
        {conflict && (
          <Banner tone="warn" action={<Button type="button" variant="secondary" size="sm" onClick={takeTheirs}>Load the saved draft</Button>}>
            This draft was saved from another tab or by someone else. Your next change replaces that save.
          </Banner>
        )}

        {step === 1 && (
          // both sides side by side, in equal columns (symmetric); each its source, label, sign and filters
          <div className="grid items-start gap-section md:grid-cols-2">
            {([0, 1] as const).map((i) => (
              <Panel key={i} title={`Side ${i === 0 ? "A" : "B"}`}>
                <fieldset disabled={!editable} className="contents">
                  <SideEditor spec={spec} i={i} fields={fields} sourceName={sourceOf(i)?.name ?? "Loading…"} place={placed?.side === i ? placed : null}
                    onChange={(x) => change({ ...spec, sides: i === 0 ? [x, spec.sides[1]] : [spec.sides[0], x] })}
                    onRemoved={(message, restore) => offerUndo(message, null, (cur) => restore(cur))} />
                </fieldset>
              </Panel>
            ))}
            {/* which sides must find their counterpart (DEC-055): versioned like every setting */}
            <Panel className="md:col-span-2">
              <DirectionPicker disabled={!editable} value={directionOf(spec)} onChange={(direction) => change({ ...spec, direction })} />
            </Panel>
          </div>
        )}

        {step === 2 && (
          <>
            {editable && gaps.length > 0 && (
              <Banner tone="error" action={<Button type="button" variant="create" size="sm" disabled={!fields[0]?.has("currency") || !fields[1]?.has("currency")}
                onClick={() => change(addCurrencyCondition(spec, gaps))}><Icon icon={AddIcon} />Add currency condition</Button>}>{currencyGapText(gaps, fields)}</Banner>
            )}
            {/* the approval actions' problems as one line to the step that fixes them (audit 2), the rest one each */}
            {warned.approval > 0 && (
              <Banner tone="warn" action={<Button type="button" variant="secondary" size="sm" onClick={() => go(4)}>Open {STEP_LABEL[4]}</Button>}>
                {approvalNotice(warned.approval)}
              </Banner>
            )}
            {warned.page.map((w) => <Banner key={w} tone="warn">{w}</Banner>)}
            {spec.passes.length === 0 ? (
              // no pass yet: the ready passes as the way in (a blank one last)
              <Panel title="Start with a pass" description="Each pass pairs the items the ones before it left. Pick one to start; you can change everything in it.">
                <div className="grid gap-3 md:grid-cols-2">
                  {PASS_TEMPLATES.map((t) => {
                    const reason = passLimit ?? templateReason(t.id, fields);
                    return (
                      <button key={t.id} type="button" disabled={!editable || !!reason} onClick={() => addPass(t.id)}
                        className="grid gap-1 rounded-lg border border-line bg-card p-4 text-left hover:border-line-strong hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary">
                        <span className="text-label text-fg">{t.label}</span>
                        <span className="text-caption text-fg-3">{reason ?? t.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </Panel>
            ) : (
              <Panel title="Passes in run order" description={editable && spec.passes.length > 1 ? "Drag a pass or press Alt+↑/↓ to move it. Select a pass to change it." : "Select a pass to change it."}
                actions={<span className="max-md:hidden"><Segmented label="Show the passes as" value={view} onChange={setView} options={[{ value: "list", label: "List" }, { value: "canvas", label: "Canvas" }]} /></span>}>
                <div className="grid gap-3">
                  {view === "canvas" && (
                    <div className="overflow-hidden rounded-md border border-line max-md:hidden">
                      <CanvasLoader spec={spec} keys={keys} counters={undefined} dim={false} selectedId={selectedId} editable={editable} onSelect={(x) => select(x)} onMove={onCanvasMove} />
                    </div>
                  )}
                  <div className={cn(view === "canvas" && "md:hidden")}>{passList(false)}</div>
                  {editable && <span><AddPassMenu fields={fields} reason={passLimit} onAdd={addPass} /></span>}
                </div>
              </Panel>
            )}
          </>
        )}

        {step === 3 && (
          <>
            {gates.map((w) => {
              const fix = editable ? carryOverFix(w) : null;
              return <Banner key={w} tone="warn" action={fix !== null && spec.carry_over_days !== null && spec.carry_over_days < fix
                ? <Button type="button" variant="secondary" size="sm" onClick={() => change({ ...spec, carry_over_days: fix })}>Set carry over to {daysText(fix)}</Button> : undefined}>{w}</Banner>;
            })}
            <Panel title="Schedule and day close">
              <fieldset disabled={!editable} className="contents"><SettingsEditor spec={spec} place={placed?.setting ? placed : null} onChange={change} onClockProblem={onClockProblem} /></fieldset>
            </Panel>
          </>
        )}

        {step === 4 && (
          <ApprovalStep spaceId={spaceId} configId={recon.id} versionId={saved.id} recon={recon.name} spec={spec} fields={fields} disabled={!editable} dirty={dirty} onUnfinished={setApprovalOpen}
            onChange={(approvals) => { const { approvals: _, ...rest } = spec; change(approvals ? { ...rest, approvals } : rest); }} />
        )}

        {step === 5 && (
          <>
            <Panel title="Test the draft" description="Nothing is stored and no item changes">
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <ReplayRange value={range} onChange={setRange} disabled={!editable || live || starting} />
                  {/* the next step is the primary: the simulation until it lets Next through, then Next (one primary, P6) */}
                  <BlockedButton type="button" variant={why[5] === null ? "secondary" : "default"} reason={simBlocked} disabled={live || starting} aria-busy={live || starting || undefined} onClick={() => void simulate()}>
                    {(live || starting) && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{simulated === "none" ? "Run simulation" : "Run it again"}
                  </BlockedButton>
                </div>
                {gap && (
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-fg-2">
                    <span>{gap}</span>
                    {suggested && (suggested.from !== range.from || suggested.to !== range.to) && !live && !starting && editable && (
                      <Button type="button" variant="secondary" size="sm" onClick={() => setRange(suggested)}>Replay {rangeText(suggested.from, suggested.to)}</Button>
                    )}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <SimChip chip={sim.chip} />
                  <span role="status" className="text-body-sm text-fg">{sim.line}{simulation.stalled ? ` · ${STALL_TEXT}` : ""}</span>
                  {simulation.shown && <Link href={reconRunHref(spaceId, recon.id, simulation.shown.id)} className="text-body-sm text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-primary">Open the full results</Link>}
                </div>
                {totals && <span className={cn("text-caption text-fg-3 tabular", sim.dim && "opacity-60")}>{countLine(totals, [spec.sides[0].label, spec.sides[1].label])}</span>}
              </div>
            </Panel>
            {spec.passes.length > 0 && (
              <Panel title="What each pass pairs" description={counters ? "From the simulation above, in run order" : "Run the simulation to see each pass's pairs"}>
                <div className="grid gap-3">
                  {passList(true)}
                  <div className="grid gap-3 text-caption text-fg-3 md:grid-cols-2">
                    <div className="grid gap-1 border-l-2 border-line pl-3">
                      <span className="text-label text-fg-2">Waiting during the day{counters ? ` · ${formatNumber(counters.open.a)} ${spec.sides[0].label} · ${formatNumber(counters.open.b)} ${spec.sides[1].label}` : ""}</span>
                      <span>Waits {graceText(spec.grace_minutes).toLowerCase()} after the other side is complete · carry over: {carryText(spec.carry_over_days, spec.direction === "a_to_b" ? spec.sides[1].label : undefined).replace(/^./, (x) => x.toLowerCase())}</span>
                    </div>
                    <div className="grid gap-1 border-l-2 border-line pl-3">
                      <span className="text-label text-fg-2">Unmatch at day close</span>
                      <span className={cn("tabular", sim.dim && "opacity-60")}>{spec.direction === "a_to_b" ? `Items still open at ${spec.close_at} ${APP_TIME_ZONE_LABEL}: ${spec.sides[0].label}'s stay unmatched; ${spec.sides[1].label}'s with no counterpart at all are not required; differences and duplicates stay unmatched` : `Items still open at ${spec.close_at} ${APP_TIME_ZONE_LABEL} stay unmatched`} · {projection ? projectionText(projection, [spec.sides[0].label, spec.sides[1].label], [CURRENCY_DIFFERS]) || "none" : DASH}</span>
                    </div>
                    {currency && (
                      <div className={cn("grid gap-1 border-l-2 border-down-mark pl-3", sim.dim && "opacity-60")}>
                        <span className="text-label text-down-ink">{CURRENCY_DIFFERS}</span>
                        <span className="tabular">{currency} · unmatch at day close</span>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            )}
          </>
        )}

        {step === 6 && (
          <>
            {/* the whole draft as the Configuration will show it, each part with Edit back to its step */}
            <SpecView spaceId={spaceId} spec={spec} onEdit={editable ? (n) => go(n) : undefined} />
            <Panel title="Test" actions={editable ? <Button type="button" variant="edit" size="sm" onClick={() => go(5)}><Icon icon={EditIcon} />Edit</Button> : undefined}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <SimChip chip={sim.chip} />
                <span className="text-body-sm text-fg">{sim.line}</span>
              </div>
            </Panel>
            {submitError && <p role="alert" className="text-body-sm text-down-ink">{submitError}</p>}
          </>
        )}

        {editable && (
          <FormFooter
            primary={<BlockedButton type="submit" reason={why[step]} disabled={step === 6 && submitting} aria-busy={(step === 6 && submitting) || undefined}>
              {step === 6 && submitting && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}{step === 6 ? "Submit for approval" : `Next: ${STEP_LABEL[(step + 1) as WizardStep]}`}
            </BlockedButton>}
            back={step > 1 && <Button type="button" variant="secondary" onClick={() => go((step - 1) as WizardStep)}>Back</Button>}
            close={<Button asChild variant="ghost"><Link href={exitHref}>Save and close</Link></Button>} />
        )}
      </form>

      {sheet && body && <InspectorSheet title={title} onClose={() => {
        setSheet(false);
        if (view === "canvas" && !onPhone() && selectedId) focusNode(selectedId);
        else if (sel.k === "pass") focusLater(`pass-${sel.key}`);
      }}><div onKeyDown={onInspectorKey}>{body}</div></InspectorSheet>}
      {guard.leaving && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) guard.stay(); }} auditFields={false} reasons={[]} destructive title="Leave without saving"
          onCloseAutoFocus={(e) => { e.preventDefault(); guard.restoreFocus(); }} description={clockText ? `${clockText} The time typed isn't saved.` : failed ? `The last change wasn't saved: ${problem?.text ?? "the save failed"}` : `Draft v${saved.version} is still saving the last change.`}
          impact={["Changes not saved yet are discarded."]} actionLabel="Leave page" onConfirm={async () => guard.leave()} />
      )}
    </Wizard>
  );
}
