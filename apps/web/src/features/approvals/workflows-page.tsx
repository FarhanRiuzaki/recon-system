"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Failure, InteractiveCard, Panel } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { formatDate } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { ChevronRightIcon } from "@starterkit/ui/ui/icons";
import { BRAND } from "@starterkit/shared/brand";
import type { WorkflowListDto, WorkflowRowDto } from "@starterkit/shared/contracts/workflows";
import { WORKFLOW_ACTION_LABEL, WORKFLOW_ACTION_TEXT } from "@starterkit/shared/workflows";
import { PageHeader } from "@/components/shell/page-header";
import { api } from "@/lib/client/api";
import { workflowList } from "@/lib/shared/queries-recon";

/** The chain's depth as numbered steps on a line: as many as the workflow's longest rule has levels. */
export function LevelDots({ n, muted }: { n: number; muted?: boolean }) {
  return (
    <span aria-hidden="true" className="flex items-center">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && <span className="h-px w-3 bg-line-strong" />}
          <span className={cn("grid size-5 place-items-center rounded-full text-caption tabular", muted ? "bg-tray text-fg-3" : "bg-primary-soft text-primary")}>{i + 1}</span>
        </span>
      ))}
    </span>
  );
}

function chainLine(r: WorkflowRowDto): string {
  if (!r.published) return "Default · 1 of Reviewer or Space admin";
  const p = r.published;
  return `Version ${p.version} · ${p.rules === 0 ? "default chain only" : `${p.rules} ${p.rules === 1 ? "rule" : "rules"}`} · up to ${Math.max(1, p.levels)} ${Math.max(1, p.levels) === 1 ? "level" : "levels"}`;
}

/**
 * A space's approval workflows (DEC-052): one card per action that needs approval, the chain it takes now (its live
 * version, or the default) and an open draft or a version waiting for approval. A card opens its editor.
 */
export function WorkflowsPage({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const d = workflowList(spaceId);
  const q = useQuery({ queryKey: d.key, queryFn: () => api<WorkflowListDto>(d.url) });
  return (
    <div className="grid gap-section">
      <PageHeader title="Workflows" description={`Who approves each change in ${spaceName}, level by level.`} />
      {q.error && !q.data ? <Panel><Failure title="Couldn't load the workflows" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} /></Panel> : (
        <ul className="grid gap-3">
          {(q.data?.items ?? []).map((r) => (
            <li key={r.action}>
              <InteractiveCard asChild className="flex items-center gap-4 md:p-5">
                <Link href={`/spaces/${encodeURIComponent(spaceId)}/workflows/${r.action}`}>
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-title-3 text-fg">{WORKFLOW_ACTION_LABEL[r.action]}</span>
                      {r.open && (
                        <span className={cn("rounded-full px-2 py-0.5 text-caption", r.open.status === "in_review" ? "bg-degraded-soft text-degraded-ink" : "bg-tray text-fg-2")}>
                          {r.open.status === "in_review" ? `Version ${r.open.version} waits for approval` : `Draft ${r.open.version}`}
                        </span>
                      )}
                    </span>
                    <span className="text-body-sm text-fg-2">{WORKFLOW_ACTION_TEXT[r.action]}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-3">
                      <LevelDots n={Math.max(1, r.published?.levels ?? 1)} muted={!r.published} />
                      <span>{chainLine(r)}</span>
                      {r.published?.decidedAt && <span>Live since {formatDate(Date.parse(r.published.decidedAt))}</span>}
                    </span>
                  </span>
                  <Icon icon={ChevronRightIcon} className="shrink-0 text-fg-3" />
                </Link>
              </InteractiveCard>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
