"use client";

import Link from "next/link";
import { Notice } from "@starterkit/ui/ds";
import { plural } from "@starterkit/ui/lib/format";
import { useImportIssues } from "@/components/shell/sidebar";

/** On the Import pages other than Monitoring: while issues are open, how many, with the way to Monitoring (owner: on-screen alerts, no email). */
export function IssuesNotice() {
  const n = useImportIssues();
  if (!n) return null;
  return (
    <Notice tone="warn" live>
      {plural(n, "import issue needs", "import issues need")} attention: late or failed dates, or a stuck scheduler.{" "}
      <Link href="/imports" className="font-medium underline">Open monitoring</Link>
    </Notice>
  );
}
