"use client";

import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { BlockedButton, Panel, StatusChip } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { FailedIcon, MenuIcon, SpinnerIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import type { PassSpec, ReconDto, ReconSpec, ReconVersionDto } from "@starterkit/shared/contracts/recon";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import { recordFields, type SourceSpecLike } from "@starterkit/shared/recon";
import type { SourceKind } from "@starterkit/shared/sources";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { api, errorText } from "@/lib/client/api";
import { useLeaveGuard } from "@/lib/client/use-leave-guard";
import { RECON_KEY, reconDetail } from "@/lib/shared/queries";
import { PassEditor, PlaceError, SettingsEditor, SideEditor } from "./inspector";
import {
  addCurrencyCondition, addPass, carryOverFix, conditionText, currencyGaps, currencyGapText, daysText, type Fields, filterText, graceText, measureText, moved, movePass,
  pairText, type Place, placeOf, removePass, scheduleText, submitReason,
} from "./spec-model";
import { MAKER_REASON, reconApi, useSideSource } from "./use-recons";

const InspectorSheet = dynamic(() => import("./inspector-sheet"), { ssr: false });

/** Why Run simulation is off until the engine's simulation route exists (controller's decision, BUILDER-SPEC). */
export const SIMULATION_REASON = "Simulation isn't available yet.";
const KIND: Record<SourceKind, string> = { file_inbox: "File inbox", db_watermark: "Database · watermark", db_snapshot: "Database · snapshot" };
const DASH = "—";

type Selected = { k: "pass"; key: string } | { k: "side"; i: 0 | 1 } | { k: "settings" };
/** A new pass's stable key (the list keeps a pass's DOM and focus while it moves). */
let nextKey = 0;
const newKey = () => `p${++nextKey}`;

/** The simulation's state of a draft (BUILDER-SPEC "Simulation bar"). */
function simState(v: ReconVersionDto) {
  if (v.simulatedHash === null) return { chip: { health: "unknown", label: "Not simulated" } as const, line: `Draft v${v.version} · not simulated yet` };
  if (v.simulatedHash !== v.specHash) return { chip: { health: "degraded", label: "Out of date" } as const, line: "The draft changed after the last simulation" };
  return { chip: { health: "healthy", label: "Simulated" } as const, line: `Draft v${v.version} · simulated` };
}

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

/** "In / Left / Unmatched" between the items once a simulation ran; until then every connector says so. */
const Connector = () => <div className="ml-5 border-l border-line py-2 pl-4 text-caption text-fg-3">Not simulated</div>;

/** A pass of the run order: drag handle, the pass (select it; Alt+↑/↓ moves it), its outcome. */
function PassItem({ id, pass, fields, selected, editable, last, onSelect, onKey }: {
  id: string; pass: PassSpec; fields: Fields; selected: boolean; editable: boolean; last: boolean; onSelect: () => void; onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform: t, isDragging } = useSortable({ id, disabled: !editable });
  return (
    <li ref={setNodeRef} style={t ? { transform: `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)` } : undefined}
      className={cn(isDragging ? "relative z-10" : "motion-safe:transition-transform motion-safe:duration-(--dur-enter)")}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem]">
      <div className={cn("flex min-w-0 items-start gap-1 rounded-md border bg-card p-3", selected ? "border-fg shadow-sm" : "border-line", isDragging && "shadow-overlay")}>
        {editable && (
          <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} aria-label={`Drag pass ${pass.no}`}
            className="mt-0.5 inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-3 hover:bg-tray focus-visible:outline-2 focus-visible:outline-primary">
            <Icon icon={MenuIcon} />
          </button>
        )}
        <button id={`pass-${id}`} type="button" aria-pressed={selected} onClick={onSelect} onKeyDown={onKey}
          className="grid min-w-0 flex-1 gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <span className="flex items-center gap-2">
            <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-fg text-caption text-bg tabular">{pass.no}</span>
            <span className="min-w-0 truncate text-label text-fg">{pass.name}</span>
          </span>
          <span className="flex flex-wrap gap-1.5 text-caption text-fg-2">
            <span className="rounded-sm bg-tray px-1.5 py-0.5">{pass.cardinality}</span>
            <span className="rounded-sm bg-tray px-1.5 py-0.5">{pass.accept === "auto" ? "Auto-accept" : "Suggest"}</span>
            {pass.blocking.length > 0 && <span className="rounded-sm bg-tray px-1.5 py-0.5">Candidates by {pass.blocking.map((f) => pairText(f, fields)).join(", ")}</span>}
          </span>
          <span className="grid gap-0.5 font-mono text-mono text-fg-2 wrap-anywhere">
            {pass.predicates.map((q, j) => <span key={j}>{conditionText(q, fields)}</span>)}
          </span>
        </button>
      </div>
      <div className="grid content-start gap-1 rounded-md border border-dashed border-line p-3 text-caption text-fg-3">
        <span className="text-label text-fg-2">{pass.accept === "auto" ? "Matched" : "Suggested"}</span>
        <span>{DASH}</span>
      </div>
      </div>
      {!last && <Connector />}
    </li>
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
export function Builder({ spaceId, recon, version, editable, canEdit, bar = true }: {
  spaceId: string; recon: ReconDto; version: ReconVersionDto; editable: boolean; canEdit: boolean; bar?: boolean;
}) {
  const qc = useQueryClient();
  const [spec, setSpec] = useState<ReconSpec>(version.spec);
  const [saved, setSaved] = useState<ReconVersionDto>(version);
  const [keys, setKeys] = useState<string[]>(() => version.spec.passes.map(newKey));
  const [sel, setSel] = useState<Selected>(() => (keys[0] ? { k: "pass", key: keys[0] } : { k: "side", i: 0 }));
  const [sheet, setSheet] = useState(false);
  const [problem, setProblem] = useState<Place | null>(null);
  const [busy, setBusy] = useState<null | "save" | "submit">(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const sa = useSideSource(spaceId, spec.sides[0].source_id), sb = useSideSource(spaceId, spec.sides[1].source_id);
  const specA = sa.data?.published?.spec ?? null, specB = sb.data?.published?.spec ?? null;
  const sourceSpecs: [SourceSpecLike | null, SourceSpecLike | null] = [specA, specB];
  const fields: Fields = useMemo(() => [specA ? recordFields(specA) : null, specB ? recordFields(specB) : null], [specA, specB]);
  const dirty = JSON.stringify(spec) !== JSON.stringify(saved.spec);
  const guard = useLeaveGuard(editable && dirty && busy === null);
  const gaps = currencyGaps(spec, sourceSpecs);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const inspectorRef = useRef<HTMLDivElement>(null);

  const passIndex = sel.k === "pass" ? keys.indexOf(sel.key) : -1;
  const change = (next: ReconSpec) => { setSpec(next); setProblem(null); setSubmitError(null); };
  const focusLater = (id: string) => requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(id)?.focus()));
  const onPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  const select = (s: Selected) => {
    setSel(s);
    if (onPhone()) setSheet(true);
    else requestAnimationFrame(() => { const h = inspectorRef.current?.querySelector<HTMLElement>("h2"); h?.setAttribute("tabindex", "-1"); h?.focus(); });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= keys.length || from === to) return;
    change(movePass(spec, from, to));
    setKeys(moved(keys, from, to));
    setSaid(`Moved to pass ${to + 1}`);
  };
  const onPassKey = (i: number, key: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!editable || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    move(i, i + (e.key === "ArrowUp" ? -1 : 1));
    focusLater(`pass-${key}`);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => { if (over) move(keys.indexOf(String(active.id)), keys.indexOf(String(over.id))); };

  async function save() {
    setBusy("save");
    setProblem(null);
    try {
      const v = await api<ReconVersionDto>(reconApi(spaceId, recon.id, `/versions/${encodeURIComponent(saved.id)}`), { method: "PATCH", body: JSON.stringify({ spec }) });
      setSaved(v);
      setSpec(v.spec);
      qc.setQueryData(reconDetail(spaceId, recon.id).key, (r: ReconDto | undefined) => (r ? { ...r, draft: v } : r));
      void qc.invalidateQueries({ queryKey: RECON_KEY });
      toast(`Saved Draft v${v.version}.`);
    } catch (e) {
      const place = placeOf(errorText(e));
      setProblem(place);
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
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    setBusy("submit");
    setSubmitError(null);
    try {
      setSaved(await api<ReconVersionDto>(reconApi(spaceId, recon.id, `/versions/${encodeURIComponent(saved.id)}/submit`), { method: "POST", body: "{}" }));
      toast(`Draft v${saved.version} of ${recon.name} sent for approval. A config checker approves or rejects it.`);
      await qc.invalidateQueries({ queryKey: RECON_KEY });
    } catch (e) {
      setSubmitError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const sim = simState(saved);
  const blocked = !canEdit ? MAKER_REASON : submitReason(saved, { dirty, passes: spec.passes.length, gaps });
  const placed = problem && (problem.pass !== undefined || problem.side !== undefined || problem.setting) ? problem : null;
  const loose = problem && !placed ? problem.text : null;
  const title = sel.k === "settings" ? "Settings" : sel.k === "side" ? `Side ${sel.i === 0 ? "A" : "B"}` : passIndex >= 0 ? `Pass ${passIndex + 1} of ${spec.passes.length}` : "Pass";
  const sourceOf = (i: 0 | 1) => (i === 0 ? sa.data : sb.data);
  const editor = sel.k === "settings"
    ? <SettingsEditor spec={spec} place={placed?.setting ? placed : null} onChange={change} />
    : sel.k === "side"
      ? <SideEditor spec={spec} i={sel.i} fields={fields} sourceName={sourceOf(sel.i)?.name ?? "Loading…"} place={placed?.side === sel.i ? placed : null}
        onChange={(s) => change({ ...spec, sides: sel.i === 0 ? [s, spec.sides[1]] : [spec.sides[0], s] })} />
      : passIndex >= 0
        ? <PassEditor spec={spec} i={passIndex} fields={fields} place={placed?.pass === passIndex + 1 ? placed : null}
          onChange={(p) => change({ ...spec, passes: spec.passes.map((x, j) => (j === passIndex ? p : x)) })}
          onMove={(dir) => { move(passIndex, passIndex + dir); focusLater(`pass-${keys[passIndex]}`); }}
          onRemove={() => {
            const rest = keys.filter((_, j) => j !== passIndex);
            change(removePass(spec, passIndex));
            setKeys(rest);
            setSel(rest[0] ? { k: "pass", key: rest[Math.min(passIndex, rest.length - 1)]! } : { k: "side", i: 0 });
            setSheet(false);
          }} />
        : null;
  const body = editor && <fieldset disabled={!editable} className="contents">{editor}</fieldset>;
  const onInspectorKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || sel.k !== "pass" || (e.target as HTMLElement).closest("[data-slot=popover-content],[role=dialog]")) return;
    document.getElementById(`pass-${sel.key}`)?.focus();
  };

  return (
    <div className="grid gap-section">
      <p aria-live="polite" className="sr-only">{said}</p>
      {bar && saved.status === "draft" && (
        <section aria-label="Simulation" className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-line bg-card p-4 shadow-xs">
          <StatusChip health={sim.chip.health} label={sim.chip.label} />
          <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
            <span className="text-body-sm text-fg">{sim.line}</span>
            <span className="text-caption text-fg-3">Matched {DASH} · suggested {DASH} · duplicate {DASH} · waiting {DASH} · match rate {DASH}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 max-md:w-full max-md:*:flex-1">
            {editable && (
              <BlockedButton variant={dirty ? "default" : "secondary"} reason={dirty ? null : "No changes to save."} disabled={busy !== null} aria-busy={busy === "save" || undefined} onClick={() => void save()}>
                {busy === "save" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Save draft
              </BlockedButton>
            )}
            <BlockedButton variant="secondary" reason={SIMULATION_REASON}>Run simulation</BlockedButton>
            <BlockedButton reason={blocked} disabled={busy !== null} aria-busy={busy === "submit" || undefined} onClick={() => void submit()}>
              {busy === "submit" && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Submit for approval
            </BlockedButton>
          </div>
          {(submitError || loose) && <p role="alert" className="basis-full text-body-sm text-down-ink">{submitError ?? loose}</p>}
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

      {editable && gaps.length > 0 && (
        <Banner tone="error" action={<Button type="button" variant="secondary" size="sm" disabled={!fields[0]?.has("currency") || !fields[1]?.has("currency")}
          onClick={() => change(addCurrencyCondition(spec, gaps))}>Add currency condition</Button>}>{currencyGapText(gaps)}</Banner>
      )}
      {saved.warnings.map((w) => {
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
            <p className="pt-2 text-caption text-fg-3">Two sides per recon in this release.</p>
            {placed?.side !== undefined && <div className="pt-2"><PlaceError text={`Side ${placed.side === 0 ? "A" : "B"}: ${placed.text}`} /></div>}
            <Connector />
            {spec.passes.length ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{
                screenReaderInstructions: { draggable: "To move a pass, press Space or Enter, move it with the arrow keys, then press Space or Enter to drop it, or Escape to cancel." },
                announcements: {
                  onDragStart: ({ active }) => `Picked up pass ${keys.indexOf(String(active.id)) + 1}.`,
                  onDragOver: ({ over }) => (over ? `Over position ${keys.indexOf(String(over.id)) + 1}.` : undefined),
                  onDragEnd: ({ over }) => (over ? `Moved to pass ${keys.indexOf(String(over.id)) + 1}` : "Dropped where it was."),
                  onDragCancel: () => "Move cancelled.",
                },
              }}>
                <SortableContext items={keys} strategy={verticalListSortingStrategy}>
                  <ol aria-label="Passes in run order" className="grid">
                    {spec.passes.map((p, i) => (
                      <PassItem key={keys[i]} id={keys[i]!} pass={p} fields={fields} editable={editable} selected={sel.k === "pass" && sel.key === keys[i]}
                        last={i === spec.passes.length - 1} onSelect={() => select({ k: "pass", key: keys[i]! })} onKey={onPassKey(i, keys[i]!)} />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            ) : <p className="rounded-md border border-dashed border-line p-4 text-body-sm text-fg-2">No passes yet.</p>}
            {editable && (
              <span className="pt-3">
                <BlockedButton type="button" variant="secondary" reason={spec.passes.length >= 20 ? "A recon has at most 20 passes." : !fields[0] || !fields[1] ? "The sides' sources are still loading." : null}
                  onClick={() => { const k = newKey(); change(addPass(spec, fields)); setKeys([...keys, k]); select({ k: "pass", key: k }); }}>Add pass</BlockedButton>
              </span>
            )}
            <Connector />
            <div className="grid gap-3 text-caption text-fg-3 md:grid-cols-2">
              <div className="grid gap-1 border-l-2 border-line pl-3">
                <span className="text-label text-fg-2">Waiting · during the day</span>
                <span>Waits {graceText(spec.grace_minutes).toLowerCase()} after the other side is complete · carry over {daysText(spec.carry_over_days)}</span>
              </div>
              <div className="grid gap-1 border-l-2 border-line pl-3">
                <span className="text-label text-fg-2">Break · at day close</span>
                <span>Items still open at {spec.close_at} {APP_TIME_ZONE_LABEL} become breaks · {DASH}</span>
              </div>
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
          onCloseAutoFocus={(e) => { e.preventDefault(); guard.restoreFocus(); }} description={`Draft v${saved.version} keeps what was saved last.`}
          impact={["Changes since the last save are discarded."]} actionLabel="Leave page" onConfirm={async () => guard.leave()} />
      )}
    </div>
  );
}
