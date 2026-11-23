import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { Tooltip, TooltipProvider, TooltipTrigger } from "./tooltip";

type Variant = NonNullable<Parameters<typeof Button>[0]["variant"]>;
const markup = (variant?: Variant) => renderToStaticMarkup(h(Button, { variant }, "Save"));
const classes = (out: string) => /class="([^"]*)"/.exec(out)![1]!.split(" ");

/** The affectUI look (design-system.md §3.7): what the class string carries; the gradient itself is base.css. */
describe("Button variants", () => {
  it.each([["create", "create"], ["edit", "edit"], ["remove", "down"]] as const)("intent %s (owner 24 Nov): its ink on its soft fill at rest, the -hover fill under the pointer, no border", (variant, token) => {
    const c = classes(markup(variant));
    expect(c).toEqual(expect.arrayContaining(["border-transparent", `bg-${token}-soft`, `text-${token}-ink`, `hover:bg-${token}-soft-hover`]));
    expect(c).not.toContain("bg-transparent");
  });
  it("add is gone: Create / Add / New take create", () => {
    // @ts-expect-error the variant no longer exists
    expect(markup("add")).not.toMatch(/add-ink/);
  });
  it("default: --action under the gradient, a transparent border for the lit edge, disabled at 0.4", () => {
    const out = markup();
    expect(out).toContain('data-slot="button"');
    expect(out).toContain('data-variant="default"');
    expect(classes(out)).toEqual(expect.arrayContaining(["bg-action", "border-transparent", "disabled:opacity-40"]));
    expect(classes(out)).not.toContain("disabled:opacity-50");
  });
  it("under an asChild trigger the slot name is the trigger's, the class and variant stay (what base.css keys on)", () => {
    const out = renderToStaticMarkup(h(TooltipProvider, null, h(Tooltip, null, h(TooltipTrigger, { asChild: true }, h(Button, null, "Save")))));
    expect(out).toContain('data-slot="tooltip-trigger"');
    expect(out).toContain('data-variant="default"');
    expect(classes(out)).toContain("bg-action");
  });
  it.each(["secondary", "outline"] as const)("%s: card fill, --line edge, shadow-xs", (variant) => {
    const c = classes(markup(variant));
    expect(c).toEqual(expect.arrayContaining(["border-line", "bg-card", "shadow-xs"]));
    expect(c).not.toContain("border-line-strong");
  });
  it("caution (a negative decision: Reject, Turn off, Cancel request): transparent, Down ink, --line edge, soft Down on hover and press", () => {
    const c = classes(markup("caution"));
    expect(c).toEqual(expect.arrayContaining(["border-line", "bg-transparent", "text-down-ink", "hover:bg-down-soft", "active:bg-down-soft-hover"]));
    for (const gone of ["bg-down-soft", "bg-card", "shadow-xs"]) expect(c).not.toContain(gone);
  });
  it("destructive: a soft Down fill with Down ink and no border or shadow", () => {
    const c = classes(markup("destructive"));
    expect(c).toEqual(expect.arrayContaining(["border-transparent", "bg-down-soft", "text-down-ink", "hover:bg-down-soft-hover"]));
    for (const gone of ["shadow-xs", "bg-card", "border-down-mark/40"]) expect(c).not.toContain(gone);
  });
});
