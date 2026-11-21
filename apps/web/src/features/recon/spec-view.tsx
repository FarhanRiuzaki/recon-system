"use client";

import { useMemo } from "react";
import { Panel } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import type { PassSpec, ReconSpec } from "@starterkit/shared/contracts/recon";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import { recordFields } from "@starterkit/shared/recon";
import { SOURCE_KIND_WORD, sourceKindIcon } from "./live-hooks";
import { CARDINALITY_WORDS, conditionParts, daysText, type Fields, filterText, graceText, keysText, measureText, scheduleText } from "./spec-model";
import { useSideSource } from "./use-recons";


/** A small word chip in a pass's head. */
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
          <Chip primary={pass.accept === "auto"}>{pass.accept === "auto" ? "Matches automatically" : "Suggests for review"}</Chip>
          <Chip>{CARDINALITY_WORDS[pass.cardinality]}</Chip>
        </div>
        <dl className="grid gap-3">
          <Row label="Looks at">
            <span className="text-body-sm text-fg">{pass.blocking.length ? `Items with the same ${keysText(pass.blocking)}` : "Every item still open"}</span>
          </Row>
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
          <Row label="Several fit">
            <span className="text-body-sm text-fg-2">{pass.on_ambiguous === "break" ? "Raise a break for someone to review" : "Suggest them for review"}</span>
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
          <span className="text-caption text-fg-3">Side {i === 0 ? "A" : "B"}</span>
          <span className="truncate text-label text-fg">{side.label}</span>
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
 * A recon version's spec as text (ui-standard §1a "Version": values as text, never disabled inputs, no inspector): the
 * settings, the two sides, and the passes in run order as steps (owner, 22 Nov: tidy and clear for a reader).
 */
export function SpecView({ spaceId, spec }: { spaceId: string; spec: ReconSpec }) {
  const sa = useSideSource(spaceId, spec.sides[0].source_id), sb = useSideSource(spaceId, spec.sides[1].source_id);
  const specA = sa.data?.published?.spec ?? null, specB = sb.data?.published?.spec ?? null;
  const fields: Fields = useMemo(() => [specA ? recordFields(specA) : null, specB ? recordFields(specB) : null], [specA, specB]);
  const sources: [SourceDto | undefined, SourceDto | undefined] = [sa.data, sb.data];
  return (
    <>
      <section aria-label="Settings" className="rounded-lg border border-line bg-tray px-4 py-3">
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {[["Schedule", scheduleText(spec.schedule)], ["Grace", graceText(spec.grace_minutes)], ["Carry over", daysText(spec.carry_over_days)],
            ["Day closes", `${spec.close_at} ${APP_TIME_ZONE_LABEL}`], ["Measure", measureText(spec, fields)]].map(([k, v]) => (
            <div key={k} className="grid gap-0.5"><dt className="text-caption text-fg-3">{k}</dt><dd className="text-body-sm text-fg">{v}</dd></div>
          ))}
        </dl>
      </section>

      <Panel title="Sides" description="What each side reads">
        <div className="grid gap-3 md:grid-cols-2">
          {([0, 1] as const).map((i) => (
            <div key={i} className="min-w-0 rounded-lg border border-line bg-card p-4"><SideSummary i={i} side={spec.sides[i]} source={sources[i]} fields={fields} /></div>
          ))}
        </div>
      </Panel>

      <Panel title="Passes in run order" description="Each pass takes the items the ones before it left; what none pairs waits for a counterpart">
        <ol aria-label="Passes in run order" className="grid">
          {spec.passes.map((p, i) => <PassStep key={p.no} pass={p} step={i + 1} last={i === spec.passes.length - 1} fields={fields} />)}
        </ol>
      </Panel>
    </>
  );
}
