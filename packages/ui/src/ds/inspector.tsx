"use client";

import { type ReactNode, useId } from "react";
import { Switch } from "../ui/switch";

/** The settings of what is selected (the designer's right pane): a title with its place, then sections. */
export function Inspector({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 pb-1"><span className="text-label text-fg">{title}</span>{meta && <span className="text-body-sm text-fg-3">{meta}</span>}</div>
      {children}
    </div>
  );
}

/** One group of settings, set off by a rule above (the first has none). */
export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 grid-cols-1 gap-list border-t border-line pt-3 pb-1 first-of-type:border-t-0 first-of-type:pt-0">
      <h3 className="text-caption font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A setting that applies at once, on or off (the designer saves itself): its name on the left, always visible, the
 * switch on the right, an optional line under the name. The whole row presses the switch; a disabled fieldset or
 * `disabled` stops it.
 */
export function SwitchRow({ label, description, checked, onChange, disabled }: {
  label: string; description?: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="flex min-h-8 cursor-pointer items-center justify-between gap-3 has-disabled:cursor-default">
      <span className="grid min-w-0 gap-0.5">
        <span className="text-body-sm text-fg">{label}</span>
        {description && <span id={id} className="text-caption text-fg-3">{description}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} describedBy={description ? id : undefined} />
    </label>
  );
}
