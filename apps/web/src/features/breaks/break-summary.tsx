"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Notice, StatTile, StatTiles, StatTileSkeletons } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Reveal } from "@starterkit/ui/motion";
import type { BreakSummaryDto } from "@starterkit/shared/contracts/breaks";
import { api, errorText } from "@/lib/client/api";
import { amountTile } from "@/lib/shared/amount";
import { ENGINE_KEY } from "@/lib/shared/queries";
import { breakSummaryUrl } from "@/lib/shared/queries-recon";

/**
 * The unmatch queue's KPI tray (audit Q1) under the list's filters: open items, open amount per currency, open longer
 * than carry over (by age only), assigned to me (a toggle of the Mine filter). Its own loading shape, and a notice
 * when it can't load.
 */
export function BreakSummary({ spaceId, filterQuery, mine, onMine }: { spaceId: string; filterQuery: string; mine: boolean; onMine: () => void }) {
  const url = breakSummaryUrl(spaceId, filterQuery);
  const q = useQuery({ queryKey: [ENGINE_KEY[0], url], queryFn: () => api<BreakSummaryDto>(url), placeholderData: keepPreviousData });
  const s = q.data;
  if (!s && q.isError) return <Notice tone="warn">Couldn&apos;t load the totals. {errorText(q.error)}</Notice>;
  return (
    <Reveal loading={!s} skeleton={<StatTiles><StatTileSkeletons count={4} /></StatTiles>}>
      {s && (
        <StatTiles>
          <StatTile label="Open items" value={formatNumber(s.open)} />
          <StatTile label="Open amount" {...amountTile(s.amounts)} />
          <StatTile label="Older than carry over" value={formatNumber(s.pastCarryOver)} caption="Open longer than the recon's carry over" />
          <StatTile label="Assigned to me" value={formatNumber(s.mine)} selected={mine} onSelect={onMine} />
        </StatTiles>
      )}
    </Reveal>
  );
}
