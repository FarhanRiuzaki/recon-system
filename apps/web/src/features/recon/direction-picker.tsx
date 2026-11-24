"use client";

import { RadioGroup } from "@starterkit/ui/ds";
import type { ReconDirection } from "@starterkit/shared/recon";
import { DIRECTION_OPTIONS } from "./spec-model";

/**
 * Which sides must find their counterpart (DEC-055), the one control for it on every path: a new recon's first step and
 * an existing recon's setup step 1 (owner 24 Nov: the two paths must look the same).
 */
export function DirectionPicker({ value, onChange, disabled }: { value: ReconDirection; onChange: (v: ReconDirection) => void; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled} className="contents">
      <RadioGroup name="recon-direction" legend="Direction" variant="cards" options={DIRECTION_OPTIONS} value={value} onChange={onChange} />
    </fieldset>
  );
}
