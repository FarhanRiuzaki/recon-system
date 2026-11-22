"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Failure, InteractiveCard, Panel } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { formatDate } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { ChevronRightIcon } from "@starterkit/ui/ui/icons";
import { BRAND } from "@starterkit/shared/brand";
import type { RulesListDto, RulesRowDto } from "@starterkit/shared/contracts/workflows";
import { TRIGGER_LABEL, TRIGGER_MODULE, TRIGGER_TEXT } from "@starterkit/shared/workflows";
import { PageHeader } from "@/components/shell/page-header";
import { api } from "@/lib/client/api";
import { approvalRules } from "@/lib/shared/queries-recon";

function rulesLine(r: RulesRowDto): string {
  if (!r.published) return "Every request · Default chain";
  const p = r.published;
  const rules = p.rules === 0 ? "No rules" : `${p.rules} ${p.rules === 1 ? "rule" : "rules"}`;
  return `Version ${p.version} · ${rules} · ${p.rules ? "otherwise" : "every request"} ${p.otherwise ?? "Default chain"}`;
}

/**
 * A space's approval rules (DEC-052 revision §4.3), grouped by the module whose change needs approval: per trigger, the
 * rules live now (or the default chain) and an open draft or a version waiting for approval. A row opens its editor.
 */
export function ApprovalRulesPage({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const d = approvalRules(spaceId);
  const q = useQuery({ queryKey: d.key, queryFn: () => api<RulesListDto>(d.url) });
  const modules = [...new Set((q.data?.items ?? []).map((r) => TRIGGER_MODULE[r.trigger]))];
  return (
    <div className="grid gap-section">
      <PageHeader title="Approval rules" description={`Which workflow approves each change in ${spaceName}.`} />
      {q.error && !q.data ? <Panel><Failure title="Couldn't load the approval rules" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel> : modules.map((m) => (
        <section key={m} className="grid gap-3" aria-label={m}>
          <h2 className="text-title-3 text-fg">{m}</h2>
          <ul className="grid gap-3">
            {(q.data?.items ?? []).filter((r) => TRIGGER_MODULE[r.trigger] === m).map((r) => (
              <li key={r.trigger}>
                <InteractiveCard asChild className="flex items-center gap-4 md:p-5">
                  <Link href={`/spaces/${encodeURIComponent(spaceId)}/approval-rules/${r.trigger}`}>
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-title-3 text-fg">{TRIGGER_LABEL[r.trigger]}</span>
                        {r.open && (
                          <span className={cn("rounded-full px-2 py-0.5 text-caption", r.open.status === "in_review" ? "bg-degraded-soft text-degraded-ink" : "bg-tray text-fg-2")}>
                            {r.open.status === "in_review" ? `Version ${r.open.version} waits for approval` : `Draft ${r.open.version}`}
                          </span>
                        )}
                      </span>
                      <span className="text-body-sm text-fg-2">{TRIGGER_TEXT[r.trigger]}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-3">
                        <span>{rulesLine(r)}</span>
                        {r.published?.decidedAt && <span>Live since {formatDate(Date.parse(r.published.decidedAt))}</span>}
                      </span>
                    </span>
                    <Icon icon={ChevronRightIcon} className="shrink-0 text-fg-3" />
                  </Link>
                </InteractiveCard>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
