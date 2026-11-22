"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { Panel } from "./panel";
import { Input } from "../ui/input";
import { cn } from "../lib/cn";

/**
 * One group of a long form (Polaris annotated layout, Carbon form sections): from 768 px the title and what the group
 * is for sit in a column on the left (a third) and the fields on the right, capped at a readable width (`max-w-xl`),
 * so a wide card holds the explanation instead of empty space; on a phone the title stacks above the fields. Sections
 * are divided by a hairline. Use it when a form has two groups or more; a short form (a dialog, sign-in) is one column.
 */
export function FormSection({ title, description, children, className, split = true }: { title: string; description?: ReactNode; split?: boolean; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-4 border-t border-line py-6 first-of-type:border-t-0 first-of-type:pt-0", split && "md:grid-cols-3 md:gap-8", className)}>
      <div className="grid content-start gap-1">
        <h3 className="text-title-3 text-fg">{title}</h3>
        {description && <p className="text-body-sm text-fg-3">{description}</p>}
      </div>
      <div className={cn("grid min-w-0 content-start gap-4", split && "max-w-xl md:col-span-2")}>{children}</div>
    </section>
  );
}

/**
 * A numbered section of a long editor (owner 22 Nov: "section ga keliatan … abu2 dan putih semua"): its number in the
 * primary marker (the order to fill it in), the title as a heading, what the section is for under it, actions on the
 * right. Without `n` it is a plain section title. The marker is decorative: the heading carries the name.
 */
export function SectionHeading({ n, title, description, actions, level = 2, className }: {
  n?: number; title: string; description?: ReactNode; actions?: ReactNode; level?: 2 | 3 | 4; className?: string;
}) {
  const H = `h${level}` as const;
  return (
    <div className={cn("flex items-start gap-3", className)}>
      {n !== undefined && <span aria-hidden="true" className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-label text-primary-foreground tabular">{n}</span>}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <H className="text-title-3 text-fg">{title}</H>
        {description && <span className="text-body-sm text-fg-3">{description}</span>}
      </span>
      {actions && <span className="flex shrink-0 items-center gap-2">{actions}</span>}
    </div>
  );
}

/**
 * The form's buttons, last in the card: the primary action first, then Cancel (ui-standard §5). Sticky to the bottom of
 * the window while the form is taller than it, so Save stays in reach on a long form; it takes the card's padding back
 * (`-mx-4 -mb-4`) so its hairline runs edge to edge. Pass `sticky={false}` in a dialog or a short form.
 */
export function FormActions({ children, sticky = true, className }: { children: ReactNode; sticky?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3",
      sticky && "sticky bottom-0 z-10 -mx-4 -mb-4 rounded-b-lg border-t border-line bg-card px-4 py-3 pb-[max(--spacing(3),env(safe-area-inset-bottom))]", className)}>
      {children}
    </div>
  );
}

/**
 * The footer of a form page (ui-standard §1a "Form"): `Back` in a wizard, then the primary action (`Create user`,
 * `Save user`, `Next: …`), then `Cancel`, left-aligned under the form and sticky (FormActions). A wizard that saves
 * itself ends with `close` (`Save and close`, ghost) on the right edge instead of Cancel. The order is fixed here, so
 * no form puts them another way; a destructive action is never in a footer (it is in the header's ⋯ menu). An editor
 * that saves itself has no footer.
 */
export function FormFooter({ primary, back, cancel, close, sticky, className }: { primary: ReactNode; back?: ReactNode; cancel?: ReactNode; close?: ReactNode; sticky?: boolean; className?: string }) {
  return <FormActions sticky={sticky} className={className}>{back}{primary}{cancel}{close && <span className="ml-auto">{close}</span>}</FormActions>;
}

export function Fieldset({ legend, description, children, ...props }: ComponentProps<"fieldset"> & { legend: string; description?: string }) {
  const id = useId();
  return <fieldset {...props} aria-describedby={description ? id : props["aria-describedby"]} className={cn("grid min-w-0 gap-3", props.className)}><legend className="mb-3 text-title-2">{legend}</legend>{description && <p id={id} className="text-body-sm text-fg-2">{description}</p>}{children}</fieldset>;
}
export function FormLayout({ title, children, actions, columns = 1, ...props }: ComponentProps<"form"> & { title: string; actions: ReactNode; columns?: 1 | 2 }) {
  return <Panel bodyClassName="p-6"><form {...props} className={cn("grid gap-5", props.className)}><h2 className="text-title-2">{title}</h2><div className={cn("grid gap-6", columns === 2 && "md:grid-cols-2")}>{children}</div><FormActions>{actions}</FormActions></form></Panel>;
}
export { DatePicker } from "./date-picker";
/** Time input preserves typing and the platform time keyboard. */
export function TimeInput(props: Omit<ComponentProps<typeof Input>, "type">) { return <Input {...props} type="time" />; }
