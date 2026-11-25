import type { ReactNode } from "react";

/** The settings of what is selected (the designer's right pane): a title with its place, then sections. */
export function Inspector({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline gap-2 pb-1"><span className="text-label text-fg">{title}</span>{meta && <span className="text-body-sm text-fg-3">{meta}</span>}</div>
      {children}
    </div>
  );
}

/** One group of settings, set off by a rule above (the first has none). */
export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2.5 border-t border-line pt-3 pb-1 first-of-type:border-t-0 first-of-type:pt-0">
      <h3 className="text-caption font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
      {children}
    </section>
  );
}
