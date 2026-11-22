"use client";

import { type ComponentProps, lazy, Suspense } from "react";
import type { CommandCombobox as CommandComboboxType } from "./combobox-command";
import { SearchCombobox } from "./combobox-search";
import { Skeleton } from "../ui/skeleton";
export { filterOptions, nextEnabled, type ComboOption } from "./combobox-search";

// cmdk loads only where the command variant is used (onValueChange): a form of search comboboxes (the source wizard's
// fields) doesn't carry it in its first load.
const CommandCombobox = lazy(() => import("./combobox-command").then((m) => ({ default: m.CommandCombobox })));

/** Retain both established selection contracts while sharing one public component. */
export function Combobox(props: ComponentProps<typeof CommandComboboxType> | ComponentProps<typeof SearchCombobox>) {
  return "onValueChange" in props
    ? <Suspense fallback={<Skeleton className="h-8 w-full" />}><CommandCombobox {...props} /></Suspense>
    : <SearchCombobox {...props} />;
}
