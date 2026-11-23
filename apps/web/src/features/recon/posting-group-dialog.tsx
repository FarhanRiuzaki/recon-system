"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Failure, StatusChip } from "@starterkit/ui/ds";
import { ScrollFade } from "@starterkit/ui/ds/scroll-fade";
import { formatDateTime, formatNumber } from "@starterkit/ui/lib/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { BRAND } from "@starterkit/shared/brand";
import type { PostingGroupDto } from "@starterkit/shared/contracts/integrations";
import { api, retryUnlessNotFound } from "@/lib/client/api";
import { amountText } from "@/lib/shared/amount";
import { groupChip, groupKeyText, sendsAtText } from "@/lib/shared/posting";
import { postingGroup } from "@/lib/shared/queries";
import { periodText } from "./posting-groups";

const LINK = "font-mono text-body-sm text-fg hover:underline focus-visible:outline-2 focus-visible:outline-primary";

/** One posting group (stage 5): its key, total, when it is sent and what the bank answered, and its items in joining order. Loaded on first open. */
export default function PostingGroupDialog({ spaceId, configId, groupId, onClose }: { spaceId: string; configId: string; groupId: string; onClose: () => void }) {
  const q = postingGroup(spaceId, configId, groupId);
  const g = useQuery({ queryKey: q.key, queryFn: () => api<PostingGroupDto>(q.url), retry: retryUnlessNotFound });
  const d = g.data;
  const chip = d ? groupChip(d) : null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-160">
        <DialogHeader>
          <DialogTitle>{d ? `${groupKeyText(d.keys)} · ${periodText(d)}` : "Posting group"}</DialogTitle>
          <DialogDescription>{d ? `${d.action} · ${d.variant}` : "The items it sends as one call"}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 pb-6">
          {g.error && <Failure title="Couldn't load this posting group" error={g.error} source={BRAND.name} onRetry={() => void g.refetch()} />}
          {!d && !g.error && <Skeleton className="h-40" />}
          {d && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line-strong bg-card p-3 text-body-sm">
                <dt className="text-fg-3">Status</dt><dd><StatusChip health={chip!.health} label={chip!.label} /></dd>
                <dt className="text-fg-3">Items</dt><dd className="tabular text-fg">{formatNumber(d.items)}</dd>
                <dt className="text-fg-3">Total</dt><dd className="tabular text-fg">{amountText(d.totalMinor, d.currency)} {d.currency}</dd>
                <dt className="text-fg-3">Sends</dt><dd className="text-fg">{sendsAtText(d)}</dd>
                {d.run?.message && <><dt className="text-fg-3">Bank answer</dt><dd className="text-down-ink">{d.run.message}</dd></>}
                {d.run?.bankReference && <><dt className="text-fg-3">Bank reference</dt><dd className="font-mono text-fg">{d.run.bankReference}</dd></>}
                {d.run?.externalId && <><dt className="text-fg-3">External ID</dt><dd className="font-mono text-fg">{d.run.externalId}</dd></>}
              </dl>
              <ScrollFade className="max-h-80 rounded-md border border-line-strong" tabIndex={0} aria-label="Items in this group">
                <ol className="grid divide-y divide-line">
                  {d.members.map((m) => (
                    <li key={m.itemId} className="flex items-center justify-between gap-3 px-3 py-2">
                      <Link href={`/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(m.itemId)}`} className={LINK}>{m.ref ?? "Unmatch item"}</Link>
                      <span className="grid justify-items-end">
                        <span className="tabular text-body-sm text-fg">{amountText(m.amountMinor, d.currency)}</span>
                        <span className="text-caption text-fg-3">Approved {formatDateTime(Date.parse(m.joinedAt))}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </ScrollFade>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
