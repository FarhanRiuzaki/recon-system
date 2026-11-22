"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Notice, StatTile, StatTiles, StatTileSkeletons } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Reveal } from "@starterkit/ui/motion";
import type { BreakSummaryDto } from "@starterkit/shared/contracts/breaks";
import { api, errorText } from "@/lib/client/api";
import { amountText } from "@/lib/shared/amount";
import { ENGINE_KEY } from "@/lib/shared/queries";
import { breakSummaryUrl } from "@/lib/shared/queries-recon";

/**
 * The open amount as one tile: the largest currency as the value, the others in the caption ("Also 5.00 EUR"); none
 * open is 0 without a unit.
 */
export function amountTile(amounts: BreakSummaryDto["amounts"]): { value: string; unit?: string; caption?: string } {
  const [first, ...rest] = amounts;
  if (!first) return { value: "0" };
  return {
    value: amountText(first.amountMinor, first.currency), unit: first.currency,
    caption: rest.length ? `Also ${rest.map((a) => `${amountText(a.amountMinor, a.currency)} ${a.currency}`).join(", ")}` : undefined,
  };
}

/**
 * The unmatch queue's KPI tray (audit Q1) under the list's filters: open items, open amount per currency, past carry
 * over, assigned to me (a toggle of the Mine filter). Its own loading shape, and a notice when it can't load.
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
          <StatTile label="Older than carry over" value={formatNumber(s.pastCarryOver)} caption="Runs no longer check them" />
          <StatTile label="Assigned to me" value={formatNumber(s.mine)} selected={mine} onSelect={onMine} />
        </StatTiles>
      )}
    </Reveal>
  );
}
