"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BlockedButton, EmptyState, Panel, RelativeTime, ScrollFade, StatusChip } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { LogIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SourcePullDto } from "@starterkit/shared/contracts/sources";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { api, errorText } from "@/lib/client/api";
import { INGEST_KEY, PULL_PAGE, sourcePullsFirst } from "@/lib/shared/queries";
import { PULL_STATUS } from "@/lib/shared/source-status";
import { at } from "./source-text";
import { sourceApi, useRollbackPull } from "./use-sources";

/** A pull's chip by meaning (owner 24 Nov): New rows green, Nothing new grey, Failed red, Paused grey. */
function PullChip({ status }: { status: SourcePullDto["status"] }) {
  const c = PULL_STATUS[status];
  return <StatusChip health={c.health} label={c.label} description={c.description} />;
}

/** "+12 records · 3 quarantined · 2 left out · 15 rows read", the parts that aren't zero. */
function countsOf(p: SourcePullDto): string {
  return [
    p.added ? `+${formatNumber(p.added)} ${p.added === 1 ? "record" : "records"}` : null,
    p.quarantined ? `${formatNumber(p.quarantined)} quarantined` : null,
    p.leftOut ? `${formatNumber(p.leftOut)} left out` : null,
    p.rows ? `${formatNumber(p.rows)} ${p.rows === 1 ? "row" : "rows"} read` : null,
  ].filter(Boolean).join(" · ");
}

const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const UNKNOWN_START = "This pull ran before rollback was available, so where it started isn't known. Roll back an earlier pull that offers it.";

/**
 * What rolling back `p` removes (owner, 25 Nov): it and every later pull not rolled back yet (`pulls`, newest first,
 * so the later ones are all loaded), the ones that stored rows (a new record or a quarantined line) counted with them.
 */
export function rollbackImpact(p: SourcePullDto, pulls: SourcePullDto[]): { pulls: number; records: number; quarantined: number } {
  const covered = pulls.slice(0, pulls.findIndex((x) => x.id === p.id) + 1).filter((x) => !x.rolledBackAt && (x.added > 0 || x.quarantined > 0));
  return { pulls: covered.length, records: covered.reduce((n, x) => n + x.added, 0), quarantined: covered.reduce((n, x) => n + x.quarantined, 0) };
}

/**
 * Pull history (owner, 21 Nov): a watermark source's pulls, newest first, beside the Pull card and as tall as it; the
 * list scrolls inside and loads the next page as its end comes into view. `rollback` (a source admin; null for others):
 * each pull that stored rows offers Roll back (owner, 25 Nov: a changed mapping stored rows pulled again twice), with
 * `blocked` the reason it can't now (a paused source).
 */
export function PullHistory({ spaceId, id, rollback, onQueued }: { spaceId: string; id: string; rollback: { blocked: string | null } | null; onQueued?: () => void }) {
  const undo = useRollbackPull(spaceId, id, onQueued);
  const [asking, setAsking] = useState<SourcePullDto | null>(null);
  // the first page is the server's prefetch (no request after hydration); older pages load as the list scrolls
  const firstQ = sourcePullsFirst(spaceId, id);
  const first = useQuery({ queryKey: firstQ.key, queryFn: () => api<Page<SourcePullDto>>(firstQ.url), refetchInterval: 60_000 });
  const q = useInfiniteQuery({
    queryKey: [INGEST_KEY[0], "pulls", spaceId, id, "older"],
    queryFn: ({ pageParam }) => api<Page<SourcePullDto>>(sourceApi(spaceId, id, `/pulls?page=${pageParam}&pageSize=${PULL_PAGE}`)),
    initialPageParam: 2,
    enabled: false,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total && last.page < 1000 ? last.page + 1 : undefined),
  });
  const end = useRef<HTMLLIElement>(null);
  const f = first.data;
  // more past the first page: the next one is page 2 until the older pages have their own answer
  const hasNextPage = q.data ? q.hasNextPage : !!f && f.pageSize < f.total;
  const { isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = end.current;
    if (!el || !hasNextPage) return;
    const o = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage(); }, { rootMargin: "120px" });
    o.observe(el);
    return () => o.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const pulls = [...(f?.items ?? []), ...(q.data?.pages.flatMap((p) => p.items) ?? [])].filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i);
  const total = f?.total;
  const impact = asking ? rollbackImpact(asking, pulls) : null;
  return (
    <Panel flush icon={LogIcon} title="Pull history" count={total} description="Newest first · the last 30 days" className="flex min-h-72 flex-col" bodyClassName="flex flex-1 flex-col">
      {/* the list takes the card's height (the Pull card's, beside it) and scrolls inside it */}
      <div className="relative min-h-64 flex-1">
        <div className="absolute inset-0"><ScrollFade className="h-full">
        <ol aria-label="Pulls">
          {first.isError && !pulls.length && <li className="p-4 text-body-sm text-down-ink">Couldn&apos;t load the pulls. {errorText(first.error)}</li>}
          {first.isSuccess && !pulls.length && <li><EmptyState icon={LogIcon} title="No pulls yet" description="Each pull of the source lists here once the source runs." /></li>}
          {pulls.map((p) => (
            <li key={p.id} className="grid gap-1 border-b border-line px-4 py-2.5 last:border-b-0">
              <span className="flex flex-wrap items-center gap-2">
                <PullChip status={p.status} />
                <RelativeTime at={Date.parse(p.startedAt)} touchDate={false} />
                <span className="ml-auto font-mono text-caption text-fg-3 tabular">{at(p.startedAt)} · {formatNumber(Math.max(0, Date.parse(p.finishedAt) - Date.parse(p.startedAt)))} ms</span>
              </span>
              {countsOf(p) && <span className="text-body-sm text-fg-2">{countsOf(p)}</span>}
              {p.error && <span className="text-body-sm wrap-anywhere text-down-ink">{p.error}</span>}
              {p.rolledBackAt && <span className="text-caption text-fg-3">Rolled back {at(p.rolledBackAt)}: the rows it stored were removed.</span>}
              {p.rollback === "pending" && <span className="text-caption text-fg-3">Rollback queued: the next pull removes its rows, then reads them again.</span>}
              {rollback && (p.rollback === "available" || p.rollback === "unknown_start") && (
                <span>
                  <BlockedButton variant="secondary" size="sm" reason={p.rollback === "unknown_start" ? UNKNOWN_START : rollback.blocked} onClick={() => setAsking(p)}>
                    Roll back from here
                  </BlockedButton>
                </span>
              )}
              {/* the raw watermark is a machine value: behind a disclosure (P10) */}
              {p.watermark && (
                <details className="text-caption text-fg-3">
                  <summary className="w-fit cursor-pointer rounded-xs outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary">Technical details</summary>
                  <span className="font-mono wrap-anywhere">Watermark {p.watermark}</span>
                </details>
              )}
            </li>
          ))}
          {hasNextPage && <li ref={end} className="flex items-center gap-2 px-4 py-3 text-caption text-fg-3">{isFetchingNextPage && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Loading older pulls</li>}
        </ol>
        </ScrollFade></div>
      </div>
      {asking && impact && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setAsking(null); }} auditFields={false} reasons={[]} destructive
          title="Roll back pulls"
          description={`The pull of ${at(asking.startedAt)} and every pull after it lose the rows they stored, and the watermark goes back to where it stood before that pull. The next pull, queued now, reads those rows again with the source's published version. Use it after a version change stored rows a second time.`}
          impact={[
            `${plural(impact.pulls, "pull", "pulls")} rolled back`,
            `${plural(impact.records, "record", "records")} and ${plural(impact.quarantined, "quarantined line", "quarantined lines")} removed`,
            "A business date a recon has closed refuses the rollback; nothing is removed then",
          ]}
          actionLabel="Roll back pulls"
          onConfirm={async () => { await undo.mutateAsync(asking.id); setAsking(null); }} />
      )}
    </Panel>
  );
}
