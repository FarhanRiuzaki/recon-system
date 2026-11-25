"use client";

import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Icon } from "../ui/icon";
import { CheckIcon } from "../ui/icons";

/** On/off chips for parts of a whole (the designer's "In the file": title, header block, column headers…), aria-pressed each. */
export function ToggleChips<K extends string>({ label, items, onToggle, extra }: {
  label: string; items: readonly { key: K; label: string; on: boolean }[]; onToggle: (key: K) => void; extra?: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="text-body-sm text-fg-3">{label}:</span>
      {items.map((i) => (
        <button key={i.key} type="button" aria-pressed={i.on} onClick={() => onToggle(i.key)}
          className={cn("inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-body-sm transition-colors",
            i.on ? "border-line-strong bg-card text-fg shadow-xs" : "border-dashed border-line-strong text-fg-3 line-through")}>
          {i.on && <Icon icon={CheckIcon} className="size-3.5" />}{i.label}
        </button>
      ))}
      {extra}
    </div>
  );
}
