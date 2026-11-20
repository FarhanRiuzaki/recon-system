"use client";

import { FilterChip } from "./badges";
import { type ReactNode, useState } from "react";
import { Button } from "../ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Icon } from "../ui/icon";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "../ui/icons";
import { Skeleton } from "../ui/skeleton";

export type CommandOption = {
  value: string; label: string; disabled?: boolean;
  /** A second line under the label ("table · 18 columns"). */
  description?: string;
  /** The heading the option is listed under (a schema); options keep their order, a group its first place. */
  group?: string;
  /** The label in the mono face (a machine name). */
  mono?: boolean;
  /** What the trigger shows once chosen, when the label alone is not enough ("core.tx" for "tx" under core). */
  chosen?: string;
};

/** `options` in groups by `group`, each where its first option is; ungrouped options under the null heading. */
function grouped(options: readonly CommandOption[]): [string | null, CommandOption[]][] {
  const out = new Map<string | null, CommandOption[]>();
  for (const o of options) out.set(o.group ?? null, [...(out.get(o.group ?? null) ?? []), o]);
  return [...out];
}

/**
 * Searchable controlled selection; use query/onQuery for server options, never filter a server page locally. Server
 * mode extras: `loadingText` (three skeleton rows, the text for screen readers), `emptyText`, `footer` (inside the list,
 * after the options: a truncation line, a way out), `status` (a polite live line: "50 of 1,284 tables shown"),
 * `retryDisabled` (Retry waits, a rate limit), `phone="sheet"` (below 768 px the list is a bottom sheet with Cancel).
 */
export function CommandCombobox({
  id, label, options, value, onValueChange, multiple = false, disabled, loading, error, onRetry, query, onQuery, "aria-describedby": describedBy,
  placeholder, searchPlaceholder, loadingText, emptyText, footer, status, retryDisabled, phone, open: openProp, onOpenChange,
}: {
  id?: string; label: string; options: readonly CommandOption[];
  value: readonly string[]; onValueChange: (value: string[]) => void; multiple?: boolean; disabled?: boolean;
  loading?: boolean; error?: string; onRetry?: () => void; query?: string; onQuery?: (query: string) => void; "aria-describedby"?: string;
  placeholder?: string; searchPlaceholder?: string; loadingText?: string; emptyText?: ReactNode; footer?: ReactNode; status?: string; retryDisabled?: boolean;
  phone?: "sheet"; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => { setOpenState(o); onOpenChange?.(o); };
  const selected = value.map((v) => { const o = options.find((x) => x.value === v); return o?.chosen ?? o?.label ?? v; }).join(", ");
  const sheet = phone === "sheet";
  const item = (o: CommandOption) => (
    <CommandItem key={o.value} value={o.value} keywords={[o.label]} disabled={o.disabled} className={o.description ? "h-auto min-h-9 py-1.5 max-md:min-h-11" : sheet ? "max-md:min-h-11" : undefined}
      onSelect={() => { onValueChange(multiple ? value.includes(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value] : [o.value]); if (!multiple) setOpen(false); }}>
      <span className="grid min-w-0 flex-1">
        <span className={o.mono ? "truncate font-mono text-mono" : "truncate"}>{o.label}</span>
        {o.description && <span className="truncate text-caption text-fg-2">{o.description}</span>}
      </span>
      {value.includes(o.value) && <><Icon icon={CheckIcon} /><span className="sr-only">Selected</span></>}
    </CommandItem>
  );
  return <div className="grid min-w-0 gap-2"><Popover open={open} onOpenChange={setOpen} modal>
    <PopoverTrigger asChild><Button id={id} type="button" variant="secondary" disabled={disabled} aria-label={`${label}: ${selected || "Choose"}`} aria-describedby={describedBy} className="w-full min-w-0 justify-start border-control-border font-normal">
      <Icon icon={SearchIcon} /><span className={selected ? "flex-1 truncate text-left" : "flex-1 truncate text-left text-fg-3"}>{selected || placeholder || "Search…"}</span><Icon data-slot="disclosure-icon" icon={ChevronDownIcon} />
    </Button></PopoverTrigger>
    <PopoverContent aria-label={label} align="start" className={sheet ? "p-0 md:w-(--radix-popover-trigger-width) md:min-w-80" : "p-0"} data-phone={sheet ? "sheet" : undefined}>
      <Command shouldFilter={!onQuery} label={label} className={sheet ? "max-md:h-full" : undefined}>
        {sheet && <div className="flex items-center justify-between border-b border-line px-4 py-2 md:hidden"><span className="text-label text-fg">{label}</span><Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button></div>}
        <CommandInput aria-label={`Search ${label}`} value={query} onValueChange={onQuery} placeholder={searchPlaceholder ?? "Search…"} />
        <CommandList aria-label={label} className={sheet ? "max-md:max-h-none max-md:flex-1" : undefined}>
          {loading ? <div className="grid gap-1 p-1"><p role="status" className="sr-only">{loadingText ?? "Searching…"}</p>
            {[0, 1, 2].map((i) => <div key={i} aria-hidden="true" className="grid gap-1.5 px-2 py-2"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>)}</div>
            : error ? <div role="alert" className="grid gap-2 p-4 text-body-sm"><p>{error}</p>{onRetry && <Button type="button" variant="secondary" disabled={retryDisabled} onClick={onRetry}>Retry</Button>}</div> : <>
              <CommandEmpty>{emptyText ?? "No matching options."}</CommandEmpty>
              {grouped(options).map(([g, os]) => (g === null ? os.map(item) : <CommandGroup key={g} heading={g}>{os.map(item)}</CommandGroup>))}
            </>}
          {!loading && footer && <div className="border-t border-line px-2 pt-2 pb-1 text-caption text-fg-2">{footer}</div>}
        </CommandList>
        {status !== undefined && <p aria-live="polite" className="sr-only">{status}</p>}
      </Command>
    </PopoverContent>
  </Popover>{multiple && value.length > 0 && <div className="flex flex-wrap gap-2">{value.map((v) => <FilterChip key={v} monospace={false} disabled={disabled} removeLabel={`Remove ${options.find((o) => o.value === v)?.label ?? v}`} onRemove={() => { if (!disabled) onValueChange(value.filter((x) => x !== v)); }}>{options.find((o) => o.value === v)?.label ?? v}</FilterChip>)}</div>}</div>;
}
