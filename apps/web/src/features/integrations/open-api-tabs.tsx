"use client";

import Link from "next/link";
import { RouteTabs } from "@starterkit/ui/ds/navigation";

const TABS = [{ href: "/integrations", label: "Connectors" }, { href: "/integrations/calls", label: "Call log" }] as const;

/** The two views of the Open API menu, under the header: the connectors and the log of their calls. */
export function OpenApiTabs({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <RouteTabs aria-label="Open API">
      {TABS.map((t) => <Link key={t.href} href={t.href} aria-current={current === t.href ? "page" : undefined}>{t.label}</Link>)}
    </RouteTabs>
  );
}
