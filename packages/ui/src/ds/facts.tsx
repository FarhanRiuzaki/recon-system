import type { ReactNode } from "react";

/**
 * Label / value rows of a card (audit 2 B10: one style for every card's facts): from 768 px a label column as wide as
 * its longest label (at most 14rem) and the value beside it; on a phone the value under its label. Label and value the
 * same size (body-sm), the label regular fg-3, the value fg; no row rules. An item without a value is left out.
 */
type Fact = { label: string; value: ReactNode } | readonly [string, ReactNode];

export function Facts({ items, className }: { items: readonly Fact[]; className?: string }) {
  return (
    <dl data-slot="facts" className={["grid gap-x-6 gap-y-2 text-body-sm md:grid-cols-[fit-content(14rem)_minmax(0,1fr)]", className].filter(Boolean).join(" ")}>
      {items.map((f) => ("label" in f ? f : { label: f[0], value: f[1] })).filter((i) => i.value != null && i.value !== "").map((i) => (
        <div key={i.label} className="contents">
          <dt className="text-fg-3">{i.label}</dt>
          <dd className="min-w-0 wrap-anywhere text-fg max-md:mb-1">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
