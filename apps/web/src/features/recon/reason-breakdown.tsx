"use client";

import { BreakdownCard } from "@starterkit/ui/charts";
import { WarningIcon } from "@starterkit/ui/ui/icons";
import { errorText } from "@/lib/client/api";
import { reasonParts } from "./live-model";
import { useReconReasons } from "./use-recons";

/**
 * A recon's open unmatch items by reason (audit R2, Needs action): the queue's reason counts for this recon, one series
 * colour per part in order of size, the items without a reason included, so the parts add up to its unmatch. Loaded after the page (recon-overview.tsx), its counts prefetched with it.
 */
export function ReasonBreakdown({ spaceId, id }: { spaceId: string; id: string }) {
  const q = useReconReasons(spaceId, id, true);
  const parts = reasonParts(q.data);
  const state = q.isPending ? "loading" : q.error ? (q.data ? "stale" : "error") : parts.length ? "data" : "empty";
  return (
    <BreakdownCard className="h-full" icon={WarningIcon} title="Unmatch by reason" description="Open items, every date" unit="items" max={5}
      parts={parts} otherLabel="Other reasons" state={state} error={q.error ? errorText(q.error) : undefined} onRetry={() => void q.refetch()}
      empty={{ title: "No open unmatch", description: "Items appear here when a date closes with items nothing paired." }} />
  );
}
