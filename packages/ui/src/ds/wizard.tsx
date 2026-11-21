import type { ReactNode } from "react";
import { Panel } from "./panel";
import { StepMarker, type IndicatorStep } from "./step-indicator";

/** Composition only: the caller owns validation, draft persistence, navigation and submission. */
export function Wizard({ title, steps, children }: { title: string; steps: readonly IndicatorStep[]; children: ReactNode }) {
  return <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_17.5rem]">
    <div className="min-w-0 max-xl:order-2">{children}</div>
    <aside aria-label={title} className="min-w-0 xl:sticky xl:top-6">
      <Panel bodyClassName="p-6">
        <h2 className="mb-4 text-title-2">{title}</h2>
        {/* connectors as FormWizard draws them: a short line between steps in the row (below xl), a line from under each
            marker to the next one in the rail (xl) */}
        <ol className="flex flex-wrap items-center gap-x-3 gap-y-4 xl:grid xl:gap-0">{steps.map((s, i) => <li key={s.id} aria-current={s.status === "current" ? "step" : undefined}
          className="relative flex items-start gap-3 max-xl:items-center xl:pb-6 xl:last:pb-0">
          {i > 0 && <span aria-hidden="true" className="h-px w-6 bg-line-strong xl:hidden" />}
          {i < steps.length - 1 && <span aria-hidden="true" className="absolute top-6 bottom-1 left-2.5 w-px -translate-x-1/2 bg-line-strong max-xl:hidden" />}
          <StepMarker status={s.status} n={i + 1} />
          <div className="grid min-w-0 gap-1"><span className="text-label">{s.label}</span><span className="text-caption text-fg-3">{s.status === "done" ? "Complete" : s.status === "current" ? "In progress" : "Upcoming"}</span></div>
        </li>)}</ol>
      </Panel>
    </aside>
  </div>;
}
