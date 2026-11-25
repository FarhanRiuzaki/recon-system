"use client";

import Link from "next/link";
import { RouteTabs } from "@starterkit/ui/ds/navigation";
import { reportsHref } from "./use-reports";

/** The two views of the Reports menu: the files made and the templates they are made from. */
export function ReportsTabs({ spaceId, current }: { spaceId: string; current: "files" | "templates" }) {
  return (
    <RouteTabs aria-label="Reports">
      <Link href={reportsHref(spaceId)} aria-current={current === "files" ? "page" : undefined}>Files</Link>
      <Link href={reportsHref(spaceId, "/templates")} aria-current={current === "templates" ? "page" : undefined}>Templates</Link>
    </RouteTabs>
  );
}
