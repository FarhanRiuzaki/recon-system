"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { EmptyState, Panel, RelativeTime, ScrollFade, StatusChip } from "@starterkit/ui/ds";
import type { Health } from "@starterkit/ui/lib/status";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { LogIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SourcePullDto } from "@starterkit/shared/contracts/sources";
import { api, errorText } from "@/lib/client/api";
import { INGEST_KEY, PULL_PAGE, sourcePullsFirst } from "@/lib/shared/queries";
import { at } from "./source-text";
import { sourceApi } from "./use-sources";

const STATUS: Record<SourcePullDto["status"], { health: Health; label: string; description: string }> = {
  new: { health: "healthy", label: "New rows", description: "The pull read rows and stored new records." },
  nothing_new: { health: "unknown", label: "Nothing new", description: "The table had no row past the last watermark." },
  failed: { health: "down", label: "Failed", description: "The pull couldn't read the source; the next one tries again." },
  paused: { health: "stopped", label: "Paused", description: "The table no longer fits the source's version; pulls wait for a new version." },
};

/** "+12 records · 3 quarantined · 2 left out · 15 rows read", the parts that aren't zero. */
function countsOf(p: SourcePullDto): string {
  return [
    p.added ? `+${formatNumber(p.added)} ${p.added === 1 ? "record" : "records"}` : null,
    p.quarantined ? `${formatNumber(p.quarantined)} quarantined` : null,
    p.leftOut ? `${formatNumber(p.leftOut)} left out` : null,
    p.rows ? `${formatNumber(p.rows)} ${p.rows === 1 ? "row" : "rows"} read` : null,
  ].filter(Boolean).join(" · ");
}

/**
 * Pull history (owner, 21 Nov): a watermark source's pulls, newest first, beside the Pull card and as tall as it; the
 * list scrolls inside and loads the next page as its end comes into view.
 */
export function PullHistory({ spaceId, id }: { spaceId: string; id: string }) {
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
                <StatusChip health={STATUS[p.status].health} label={STATUS[p.status].label} description={STATUS[p.status].description} />
                <RelativeTime at={Date.parse(p.startedAt)} touchDate={false} />
                <span className="ml-auto font-mono text-caption text-fg-3 tabular">{at(p.startedAt)} · {formatNumber(Math.max(0, Date.parse(p.finishedAt) - Date.parse(p.startedAt)))} ms</span>
              </span>
              {countsOf(p) && <span className="text-body-sm text-fg-2">{countsOf(p)}</span>}
              {p.error && <span className="text-body-sm wrap-anywhere text-down-ink">{p.error}</span>}
              {p.watermark && <span className="font-mono text-caption wrap-anywhere text-fg-3">Watermark {p.watermark}</span>}
            </li>
          ))}
          {hasNextPage && <li ref={end} className="flex items-center gap-2 px-4 py-3 text-caption text-fg-3">{isFetchingNextPage && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Loading older pulls</li>}
        </ol>
        </ScrollFade></div>
      </div>
    </Panel>
  );
}
