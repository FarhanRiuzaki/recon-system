"use client";

import { type ReactNode, useId } from "react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { InfoIcon } from "../ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/**
 * What a term means, one press away (design-system §5.12): a 28 px ghost ⓘ button beside a label that opens a popover
 * with a short title and the explanation, by click, tap or keyboard (never hover only: a touch screen has none). For a
 * field whose name is a technical term (watermark, id column); the note under the field stays for what to pick.
 */
export function InfoTip({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`About ${label}`} className="-my-1.5 text-fg-3 hover:text-fg">
          <Icon icon={InfoIcon} className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-labelledby={headingId} className="grid max-w-80 gap-1.5 text-body-sm text-fg-2">
        <h3 id={headingId} className="text-label text-fg">{title ?? label}</h3>
        {children}
      </PopoverContent>
    </Popover>
  );
}
