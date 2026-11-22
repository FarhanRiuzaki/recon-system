"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Panel } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { cn } from "@starterkit/ui/lib/cn";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import type { PassSpec, ReconSpec } from "@starterkit/shared/contracts/recon";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import type { Page } from "@starterkit/shared/contracts/common";
import type { LibraryRowDto } from "@starterkit/shared/contracts/workflows";
import { recordFields } from "@starterkit/shared/recon";
import { buildCatalog, type CatalogField, type Condition, conditionText } from "@starterkit/shared/conditions";
import { TRIGGER_LABEL, TRIGGERS } from "@starterkit/shared/workflows";
import { SOURCE_KIND_WORD, sourceKindIcon } from "./live-hooks";
import { carryText, conditionParts, type Fields, filterText, graceText, keysText, measureText, scheduleText } from "./spec-model";
import { approvalChanges } from "./approval-model";
import { useSideSource } from "./use-recons";
import { api } from "@/lib/client/api";
import { workflowOptions } from "@/lib/shared/queries-recon";


/** A small word chip in a pass's head. */
const SHAPE: Record<PassSpec["cardinality"], string> = { "1:1": "1 on each side", "1:N": "1 on A, several on B", "N:1": "several on A, 1 on B" };

const Chip = ({ children, primary }: { children: string; primary?: boolean }) => (
  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-caption", primary ? "bg-primary-soft text-primary" : "bg-tray text-fg-2")}>{children}</span>
);

/** One row of a pass: the question on the left (the same width in every pass), the answer on the right. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 md:grid-cols-[8rem_minmax(0,1fr)] md:gap-4">
      <dt className="text-caption text-fg-3 md:pt-0.5">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** A pass as a step a reader follows (owner, 22 Nov: clear, tidy): what it does, where it looks, when it pairs, a tie. */
function PassStep({ pass, step, last, fields }: { pass: PassSpec; step: number; last: boolean; fields: Fields }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
      {/* the run order as a rail: the step's number, a line down to the next */}
      <div aria-hidden="true" className="flex flex-col items-center">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-fg text-label text-bg tabular">{step}</span>
        {!last && <span className="w-px flex-1 bg-line" />}
      </div>
      <div className={cn("grid min-w-0 gap-3 rounded-lg border border-line bg-card p-4", !last && "mb-3")}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate text-label text-fg"><span className="sr-only">Pass {step}: </span>{pass.name || "Untitled pass"}</h3>
          <Chip primary={pass.accept === "auto"}>{pass.accept === "auto" ? "Matches" : "Suggests"}</Chip>
        </div>
        <dl className="grid gap-3">
          <Row label="Pairs when">
            <ul className="grid gap-1.5">
              {pass.predicates.map((q, j) => {
                const c = conditionParts(q, fields);
                return (
                  <li key={j} className="grid gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
                    <span className="text-body-sm text-fg">{c.field}</span>
                    <span className="min-w-0 text-body-sm text-fg-2">
                      {c.rule}
                      <span className="ml-2 font-mono text-caption wrap-anywhere text-fg-3">{c.columns}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Row>
          <Row label="Then">
            <span className="text-body-sm text-fg-2">
              <span className="text-fg">{pass.accept === "auto" ? "Matches it" : "Suggests it for review"}</span>
              {" · "}{SHAPE[pass.cardinality]}{" · "}{pass.on_ambiguous === "break" ? "several that fit raise a break" : "several that fit are suggested"}
            </span>
          </Row>
          <Row label="Compares">
            <span className="text-body-sm text-fg-2">{pass.blocking.length ? `Only items with the same ${keysText(pass.blocking)}` : "Every open item"}</span>
          </Row>
        </dl>
      </div>
    </li>
  );
}

/** A side as a reader scans it (the Configuration's Sides and the builder's side cards): how its data arrives, the source, its filter. */
export function SideSummary({ i, side, source, fields }: { i: 0 | 1; side: ReconSpec["sides"][number]; source: SourceDto | undefined; fields: Fields }) {
  return (
    <span className="flex min-w-0 items-start gap-3">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-md bg-tray text-fg-2">
        {source ? <Icon icon={sourceKindIcon(source.kind)} size={18} /> : null}
      </span>
      <span className="grid min-w-0 gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 whitespace-nowrap text-caption text-fg-3">Side {i === 0 ? "A" : "B"}</span>
          <span className="min-w-0 truncate text-label text-fg" title={side.label}>{side.label}</span>
        </span>
        <span className="truncate text-body-sm text-fg-2">
          {source ? [source.name, SOURCE_KIND_WORD[source.kind], source.publishedVersion ? null : "no approved version", source.owner ? `shared from ${source.owner.name}` : null].filter(Boolean).join(" · ") : "Loading the source…"}
        </span>
        <span className="text-caption text-fg-3">
          {side.filter.length ? `Only ${side.filter.map((f) => filterText(f, fields[i])).join(", and ")}` : "Every record"}
          {side.amount_sign === "negate" ? " · amounts with the opposite sign" : ""}
        </span>
      </span>
    </span>
  );
}

/**
 * A recon version's spec as text (ui-standard §1a "Version": values as text, never disabled inputs, no inspector): in the
 * setup's order, the two sides, the passes in run order, then the schedule and day close as steps (owner, 22 Nov: tidy and clear for a reader).
 */
export function SpecView({ spaceId, spec, onEdit, live }: {
  spaceId: string; spec: ReconSpec;
  /** On a version's review: the live version's spec, to show what this one changes in the approval setup. */
  live?: ReconSpec;
  /** In the setup's Review: each part has Edit back to its step (1 Sources, 2 Matching, 3 Schedule, 4 Approval). */
  onEdit?: (step: 1 | 2 | 3 | 4) => void;
}) {
  const edit = (n: 1 | 2 | 3 | 4) => (onEdit ? <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(n)}>Edit</Button> : undefined);
  const sa = useSideSource(spaceId, spec.sides[0].source_id), sb = useSideSource(spaceId, spec.sides[1].source_id);
  const specA = sa.data?.published?.spec ?? null, specB = sb.data?.published?.spec ?? null;
  const fields: Fields = useMemo(() => [specA ? recordFields(specA) : null, specB ? recordFields(specB) : null], [specA, specB]);
  const sources: [SourceDto | undefined, SourceDto | undefined] = [sa.data, sb.data];
  const catalog = useMemo(() => buildCatalog([
    { label: spec.sides[0].label, fields: fields[0] ?? new Map() }, { label: spec.sides[1].label, fields: fields[1] ?? new Map() },
  ]), [fields, spec.sides]);
  return (
    <>
      <Panel title="Sides" description="What each side reads" actions={edit(1)}>
        <div className="grid gap-3 md:grid-cols-2">
          {([0, 1] as const).map((i) => (
            <div key={i} className="min-w-0 rounded-lg border border-line bg-card p-4"><SideSummary i={i} side={spec.sides[i]} source={sources[i]} fields={fields} /></div>
          ))}
        </div>
      </Panel>

      <Panel title="Passes in run order" description="Each pass takes the items the ones before it left; what none pairs waits for a counterpart" actions={edit(2)}>
        <ol aria-label="Passes in run order" className="grid">
          {spec.passes.map((p, i) => <PassStep key={p.no} pass={p} step={i + 1} last={i === spec.passes.length - 1} fields={fields} />)}
        </ol>
      </Panel>

      <Panel title="Schedule and day close" actions={edit(3)}>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {[["Schedule", scheduleText(spec.schedule)], ["Grace", graceText(spec.grace_minutes)], ["Unmatch is checked", carryText(spec.carry_over_days)],
            ["Day closes", `${spec.close_at} ${APP_TIME_ZONE_LABEL}`], ["Measure", measureText(spec, fields)]].map(([k, v]) => (
            <div key={k} className="grid gap-0.5"><dt className="text-caption text-fg-3">{k}</dt><dd className="text-body-sm text-fg">{v}</dd></div>
          ))}
        </dl>
      </Panel>

      <Panel title="Approval" description="Who approves each change; the first rule that holds picks its workflow" actions={edit(4)}>
        <ApprovalSummary spaceId={spaceId} approvals={spec.approvals} catalog={catalog} live={live} />
      </Panel>
    </>
  );
}

/** The approval setup as sentences: per change, its rules in order and who approves every other request. */
function ApprovalSummary({ spaceId, approvals, catalog, live }: { spaceId: string; approvals: ReconSpec["approvals"]; catalog: readonly CatalogField[]; live?: ReconSpec }) {
  const q = workflowOptions(spaceId);
  const wf = useQuery({ queryKey: q.key, queryFn: () => api<Page<LibraryRowDto>>(`/api/spaces/${encodeURIComponent(spaceId)}/workflows?pageSize=100&sort=name`), enabled: !!approvals || !!live?.approvals });
  const changed = approvalChanges(live?.approvals, approvals, !!live);
  const name = (id: string) => wf.data?.items.find((r) => r.id === id)?.name ?? "a workflow";
  const pin = (w: { id: string; version: number } | null) => (w ? `${name(w.id)} (version ${w.version})` : "the default chain (1 of Reviewer or Space admin)");
  return (
    <ul className="grid gap-3">
      {TRIGGERS.map((k) => {
        const lines = (w: NonNullable<ReconSpec["approvals"]>["changes"][typeof k] | undefined) => (
          <>
            {w?.workflow.rules.map((r, i) => <span key={i}>{r.name}: when {conditionText(r.when as Condition, catalog)} → {pin(r.workflow)}</span>)}
            <span>{w?.workflow.rules.length ? "Every other request" : "Every request"} → {pin(w?.workflow.default ?? null)}</span>
          </>
        );
        const diff = changed.includes(k);
        return (
          <li key={k} className="grid gap-1 text-body-sm">
            <span className="flex flex-wrap items-center gap-2 text-label text-fg">
              {TRIGGER_LABEL[k]}{diff && <span className="rounded-sm bg-degraded-soft px-1.5 py-0.5 text-caption text-degraded-ink">Changed from the live version</span>}
            </span>
            <span className="grid gap-1 text-fg-2">{lines(approvals?.changes[k])}</span>
            {diff && (
              <span className="grid gap-1 border-l-2 border-line pl-3 text-caption text-fg-3">
                <span>Live version:</span>{lines(live?.approvals?.changes[k])}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
