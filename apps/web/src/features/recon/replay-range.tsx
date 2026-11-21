"use client";

import { lazy, Suspense, useState } from "react";
import type { DateRange } from "@starterkit/ui/lib/date-range";
import { appDate } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ChevronDownIcon } from "@starterkit/ui/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@starterkit/ui/ui/popover";
import { rangeText, replayEnd } from "./run-model";

const Calendar = lazy(() => import("@starterkit/ui/ds/calendar").then((m) => ({ default: m.Calendar })));

/**
 * The business dates a simulation replays or a run covers (BUILDER-SPEC "Replay select"; `label` names it): one day or a range of at most 31 dates, none
 * after today. The first pick starts the range, the second ends it (an earlier day starts it again) and closes.
 */
export function ReplayRange({ value, onChange, disabled, label = "Replay" }: { value: DateRange; onChange: (r: DateRange) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<string | null>(null);
  const [today] = useState(() => appDate(Date.now()));
  const what = label === "Replay" ? "Business dates to replay" : "Business dates to run";
  const pick = (d: string) => {
    if (!start || d < start) { setStart(d); return; }
    onChange({ from: start, to: d });
    setStart(null);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); setStart(null); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="secondary" disabled={disabled} className="justify-between gap-2 max-md:w-full">
          {label} {rangeText(value.from, value.to)}<Icon icon={ChevronDownIcon} className="text-fg-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={what} className="w-auto p-0">
        <Suspense fallback={<p role="status" className="p-4 text-body-sm">Loading calendar…</p>}>
          <Calendar className="rounded-none border-0" autoFocus label={what} initialMonth={value.to} showFooter={false}
            range={start ? { from: start, to: start } : value} max={start ? replayEnd(start, today) : today} onValueChange={pick} />
        </Suspense>
        <p role="status" className="border-t border-line px-4 py-2 text-caption text-fg-3">{start ? `From ${rangeText(start, start)}: pick the last date.` : "Pick the first date."}</p>
      </PopoverContent>
    </Popover>
  );
}
