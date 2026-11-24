"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { CategoryChip, Panel, StatusChip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import type { PassSpec, ReconSpec } from "@starterkit/shared/contracts/recon";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import { recordFields } from "@starterkit/shared/recon";
import { buildCatalog } from "@starterkit/shared/conditions";
import { SOURCE_KIND_WORD, sourceKindIcon } from "./live-hooks";
import { conditionParts, directionText, type Fields, filterText, keysText, settingsFacts, specChanges } from "./spec-model";
import { CHANGED } from "./approval-model";
import { useSideSource } from "./use-recons";
import { EditIcon } from "@starterkit/ui/ui/icons";

// the approval part (its actions' summaries too) loads after the page: the recon's routes sit near the bundle budget (DEC-040)
const ApprovalSummary = dynamic(() => import("./approval-summary").then((m) => m.ApprovalSummary), { ssr: false, loading: () => <div aria-hidden="true" className="h-40" /> });


/** A small word chip in a pass's head. */
const SHAPE: Record<PassSpec["cardinality"], string> = { "1:1": "1 on each side", "1:N": "1 on A, several on B", "N:1": "several on A, 1 on B" };

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
function PassStep({ pass, step, last, fields, changed }: { pass: PassSpec; step: number; last: boolean; fields: Fields; changed?: boolean }) {
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
          <CategoryChip slot="neutral" label={pass.accept === "auto" ? "Matches" : "Suggests"} />
          {changed && <StatusChip {...CHANGED} />}
        </div>
        <dl className="grid gap-3">
          <Row label="Pairs when">
            <ul className="grid gap-1.5">
              {pass.predicates.map((q, j) => {
                const c = conditionParts(q, fields);
                return (
                  <li key={j} className="grid gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
                    <span className="text-body-sm text-fg">{c.field}</span>
                    {/* the rule only: the sources' column names are machine values (P10) */}
                    <span className="min-w-0 text-body-sm text-fg-2">{c.rule}</span>
                  </li>
                );
              })}
            </ul>
          </Row>
          <Row label="Then">
            <span className="text-body-sm text-fg-2">
              <span className="text-fg">{pass.accept === "auto" ? "Matches it" : "Suggests it for review"}</span>
              {" · "}{SHAPE[pass.cardinality]}{" · "}{pass.on_ambiguous === "break" ? "several that fit are left unmatched" : "several that fit are suggested"}
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
  /** On a version's review: the live version's spec; each section this one changes is marked and shows the live one's. */
  live?: ReconSpec;
  /** In the setup's Review: each part has Edit back to its step (1 Sources, 2 Matching, 3 Schedule, 4 Approval). */
  onEdit?: (step: 1 | 2 | 3 | 4) => void;
}) {
  const edit = (n: 1 | 2 | 3 | 4) => (onEdit ? <Button type="button" variant="edit" size="sm" onClick={() => onEdit(n)}><Icon icon={EditIcon} />Edit</Button> : undefined);
  const sa = useSideSource(spaceId, spec.sides[0].source_id), sb = useSideSource(spaceId, spec.sides[1].source_id);
  const specA = sa.data?.published?.spec ?? null, specB = sb.data?.published?.spec ?? null;
  const fields: Fields = useMemo(() => [specA ? recordFields(specA) : null, specB ? recordFields(specB) : null], [specA, specB]);
  const sources: [SourceDto | undefined, SourceDto | undefined] = [sa.data, sb.data];
  const catalog = useMemo(() => buildCatalog([
    { label: spec.sides[0].label, fields: fields[0] ?? new Map() }, { label: spec.sides[1].label, fields: fields[1] ?? new Map() },
  ]), [fields, spec.sides]);
  const diff = useMemo(() => specChanges(live, spec, fields), [live, spec, fields]);
  const facts = settingsFacts(spec, fields);
  const measure = facts.find((f) => f.key === "measure")!;
  /** A section's title with the review's mark when the version changes it. */
  const titled = (text: string, changed: boolean | null | undefined) => (changed ? <span className="flex flex-wrap items-center gap-2">{text}<StatusChip {...CHANGED} /></span> : text);
  const was = (text: string | undefined) => (text !== undefined ? <span className="text-caption text-fg-3">Live version: {text}</span> : null);
  return (
    <>
      <Panel title={titled("Sides", diff && (diff.sides.some(Boolean) || diff.direction))} description="What each side reads" actions={edit(1)}>
        <div className="grid gap-3 md:grid-cols-2">
          {([0, 1] as const).map((i) => (
            <div key={i} className="grid min-w-0 gap-3 rounded-lg border border-line bg-card p-4">
              <SideSummary i={i} side={spec.sides[i]} source={sources[i]} fields={fields} />
              {diff?.sides[i] && live && (
                <div className="grid gap-1 border-l-2 border-line pl-3">
                  <span className="flex flex-wrap items-center gap-2 text-caption text-fg-3"><StatusChip {...CHANGED} />Live version:</span>
                  <SideSummary i={i} side={live.sides[i]} source={sources[i]} fields={fields} />
                </div>
              )}
            </div>
          ))}
        </div>
        {/* which sides must find their counterpart (DEC-055); on a review, whether it differs from the live version */}
        <dl className="mt-3 grid gap-0.5">
          <dt className="text-caption text-fg-3">Direction</dt>
          <dd className="flex flex-wrap items-center gap-2 text-body-sm text-fg">
            {directionText(spec)}
            {diff?.direction && live && <><StatusChip {...CHANGED} />{was(directionText(live))}</>}
          </dd>
        </dl>
      </Panel>

      <Panel title={titled("Passes in run order", diff && (diff.passesChanged || "measure" in diff.settings))} description="Each pass takes the items the ones before it left; what none pairs waits for a counterpart" actions={edit(2)}>
        <ol aria-label="Passes in run order" className="grid">
          {spec.passes.map((p, i) => <PassStep key={p.no} pass={p} step={i + 1} last={i === spec.passes.length - 1} fields={fields} changed={diff?.passes.has(p.no)} />)}
        </ol>
        {diff?.passesChanged && live && (
          <details className="mt-3 rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-body-sm text-fg">The live version&apos;s passes ({live.passes.length})</summary>
            <ol aria-label="The live version's passes" className="mt-3 grid">
              {live.passes.map((p, i) => <PassStep key={p.no} pass={p} step={i + 1} last={i === live.passes.length - 1} fields={fields} />)}
            </ol>
          </details>
        )}
        <dl className="mt-3 grid gap-0.5">
          <dt className="text-caption text-fg-3">Compare amounts by</dt>
          <dd className="flex flex-wrap items-center gap-2 text-body-sm text-fg">
            {measure.text}
            {diff && "measure" in diff.settings && <><StatusChip {...CHANGED} />{was(diff.settings.measure)}</>}
          </dd>
        </dl>
      </Panel>

      <Panel title={titled("Schedule and day close", diff && facts.some((f) => f.key !== "measure" && f.key in diff.settings))} actions={edit(3)}>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {facts.filter((f) => f.key !== "measure").map((f) => (
            <div key={f.key} className="grid gap-0.5">
              <dt className="text-caption text-fg-3">{f.label}</dt>
              <dd className="text-body-sm text-fg">{f.text}</dd>
              {diff && f.key in diff.settings && <dd className="flex flex-wrap items-center gap-2"><StatusChip {...CHANGED} />{was(diff.settings[f.key])}</dd>}
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title="Approval" description="Who approves each change, what is sent to the bank, and the accounts and lookup tables it reads" actions={edit(4)}>
        <ApprovalSummary spaceId={spaceId} approvals={spec.approvals} catalog={catalog} live={live} />
      </Panel>
    </>
  );
}
