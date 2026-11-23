import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";
import { Slot } from "radix-ui";

/**
 * Buttons (spec §5.3): radius 10, 32 px (28 sm), padding 0 12, 14/500, icon 16 + 6 gap; press scale 0.97 (100 ms),
 * hover fill 150 ms, disabled 0.4. `default` = the one primary per page (--action under a top-lit gradient with a lit
 * edge and a ring, drawn by base.css on `.bg-action[data-variant="default"]`; near-black / near-white); `secondary` =
 * card + line + shadow-xs; `ghost`; `destructive` = Danger (soft Down fill, Down ink, no border); `create` / `edit` /
 * `remove` = the intents by verb; `create-solid` = the page's main Create as its one primary, solid green (green / blue / red ink on their soft fill, a step darker on hover); `caution` = a
 * negative decision (Down ink, --line edge).
 * `outline` is kept as an alias of secondary for older callers.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border text-body font-medium whitespace-nowrap transition-[background-color,border-color,color,opacity,transform] duration-(--dur-fast) ease-standard outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary press-feedback active:duration-(--dur-instant) disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-transparent bg-action text-action-fg hover:bg-action-hover",
        secondary: "border-line bg-card text-fg shadow-xs hover:bg-tray",
        outline: "border-line bg-card text-fg shadow-xs hover:bg-tray",
        ghost: "border-transparent bg-transparent text-fg-2 hover:bg-tray hover:text-fg",
        destructive: "border-transparent bg-down-soft text-down-ink hover:bg-down-soft-hover",
        link: "h-auto border-transparent px-0 text-primary-ink underline underline-offset-4 hover:decoration-2 press-static",
        // intents by verb (owner 24 Nov, after 22 Nov's "eye heatmap tau harus klik apa"): colour and word together.
        // create = Create / Add / New (a row, a condition, a record; the page's one main CTA stays default); edit = Edit;
        // remove = Delete / Remove, and an X or bin that removes (an X that closes stays ghost)
        create: "border-transparent bg-create-soft text-create-ink hover:bg-create-soft-hover",
        // the page's main Create / Add / New (Create recon, New workflow, Add member): the one primary, solid green
        "create-solid": "border-transparent bg-create-solid text-create-solid-fg hover:bg-create-solid-hover",
        edit: "border-transparent bg-edit-soft text-edit-ink hover:bg-edit-soft-hover",
        remove: "border-transparent bg-down-soft text-down-ink hover:bg-down-soft-hover",
        // caution = a negative decision that changes data but is not a removal (Reject, Turn off, Cancel request): Down
        // ink on a --line edge, so it reads as a button beside a primary without shouting like Danger (ds/intent.ts)
        caution: "border-line bg-transparent text-down-ink hover:bg-down-soft active:bg-down-soft-hover",
      },
      size: {
        sm: "h-7 px-2.5 text-body-sm [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-8 px-3",
        lg: "h-9 px-3.5",
        "icon-sm": "size-7",
        icon: "size-8",
      },
    },
    // a link sits on the text line at every size: no side padding and no fixed height (audit 2 A9, "Paste a
    // connection string" 11 px in from the field above it: the size's padding won over the variant's px-0)
    compoundVariants: [{ variant: "link", class: "h-auto px-0" }],
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className, variant = "default", size = "default", asChild = false, ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
