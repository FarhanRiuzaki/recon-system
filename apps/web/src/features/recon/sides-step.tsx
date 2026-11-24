"use client";

import { Panel, StatusChip } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { sourceStatus } from "@/lib/shared/source-status";
import { DirectionPicker } from "./direction-picker";
import { type OnRemoved, SideEditor } from "./inspector";
import { SOURCE_KIND_WORD, sourceKindIcon } from "./live-hooks";
import { directionOf, type Fields, type Place } from "./spec-model";

/** The chosen source at a glance: how its data arrives and what it reads, its health and its records today. */
function SourceGlance({ s }: { s: SourceRowDto }) {
  const st = sourceStatus(s);
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-tray px-3 py-2.5">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-card text-fg-2"><Icon icon={sourceKindIcon(s.kind)} size={16} /></span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-body-sm text-fg">{SOURCE_KIND_WORD[s.kind]}{s.reads ? ` · ${s.reads}` : ""}</span>
          <StatusChip health={st.health} label={st.label} />
        </span>
        <span className="text-caption text-fg-3">{s.rowsToday === null ? "Not ingesting yet" : `${formatNumber(s.rowsToday)} records today`}{s.usedByCount ? ` · read by ${formatNumber(s.usedByCount)} ${s.usedByCount === 1 ? "recon" : "recons"}` : ""}</span>
      </span>
    </div>
  );
}

export type SourcePicker = NonNullable<Parameters<typeof SideEditor>[0]["picker"]>;

/**
 * The setup's step 1, one screen on both paths (owner 24 Nov: a new recon and an existing one's setup are the same):
 * Side A and Side B in equal columns (label, source with its glance, amount sign, filters), then the direction.
 * `picker` = a new recon's source picker per side; an existing recon's source reads only.
 */
export function SidesStep({ spec, fields, sources, editable, place, picker, onChange, onRemoved }: {
  spec: ReconSpec; fields: Fields; sources: readonly [SourceRowDto | undefined, SourceRowDto | undefined]; editable: boolean; place: Place | null;
  picker?: (i: 0 | 1) => SourcePicker; onChange: (spec: ReconSpec) => void; onRemoved: OnRemoved<[]>;
}) {
  return (
    <div className="grid items-start gap-section md:grid-cols-2">
      {([0, 1] as const).map((i) => {
        const src = sources[i];
        return (
          <Panel key={i} title={`Side ${i === 0 ? "A" : "B"}`}>
            <fieldset disabled={!editable} className="contents">
              <SideEditor spec={spec} i={i} fields={fields} sourceName={src?.name ?? "Loading…"} picker={picker?.(i)} glance={src && <SourceGlance s={src} />}
                place={place?.side === i ? place : null} onRemoved={onRemoved}
                onChange={(x) => onChange({ ...spec, sides: i === 0 ? [x, spec.sides[1]] : [spec.sides[0], x] })} />
            </fieldset>
          </Panel>
        );
      })}
      {/* which sides must find their counterpart (DEC-055): versioned like every setting */}
      <Panel className="md:col-span-2">
        <DirectionPicker disabled={!editable} value={directionOf(spec)} onChange={(direction) => onChange({ ...spec, direction })} />
      </Panel>
    </div>
  );
}
