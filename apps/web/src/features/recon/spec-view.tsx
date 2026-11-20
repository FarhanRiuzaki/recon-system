"use client";

import { useMemo } from "react";
import { Panel } from "@starterkit/ui/ds";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import { recordFields } from "@starterkit/shared/recon";
import type { SourceKind } from "@starterkit/shared/sources";
import { PassBody } from "./pass-row";
import { daysText, type Fields, filterText, graceText, measureText, scheduleText } from "./spec-model";
import { useSideSource } from "./use-recons";

const KIND: Record<SourceKind, string> = { file_inbox: "File inbox", db_watermark: "Database · watermark", db_snapshot: "Database · snapshot" };

/**
 * A recon version's spec as text (ui-standard §1a "Version": values as text, never disabled inputs, no inspector): the
 * settings strip, then the two sides and the passes in run order as read-only cards.
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
      <Panel title="Passes in run order" bodyClassName="grid gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          {([0, 1] as const).map((i) => {
            const s = spec.sides[i], src = sources[i];
            return (
              <div key={i} className="grid min-w-0 content-start gap-1.5 rounded-md border border-line bg-card p-3">
                <span className="flex min-w-0 items-baseline gap-2"><span className="text-caption text-fg-3">Side {i === 0 ? "A" : "B"}</span><span className="text-label text-fg">{s.label}</span></span>
                <span className="text-caption text-fg-2">{src ? [src.name, KIND[src.kind], src.owner ? `shared from ${src.owner.name}` : null].filter(Boolean).join(" · ") : "Loading the source…"}</span>
                <span className="grid gap-0.5 font-mono text-mono text-fg-3 wrap-anywhere">
                  {s.filter.length ? s.filter.map((f, j) => <span key={j}>{filterText(f, fields[i])}</span>) : <span>no filter</span>}
                  {s.amount_sign === "negate" && <span>amount with the opposite sign</span>}
                </span>
              </div>
            );
          })}
        </div>
        <ol aria-label="Passes in run order" className="grid gap-3">
          {spec.passes.map((p) => (
            <li key={p.no} className="grid min-w-0 gap-2 rounded-md border border-line bg-card p-3">
              <PassBody pass={p} fields={fields} />
              <span className="text-caption text-fg-3">{p.on_ambiguous === "break" ? "When several candidates fit: raise a break" : "When several candidates fit: suggest them for review"}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}
