"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Failure, StatusChip } from "@starterkit/ui/ds";
import { appDayStart, formatDate } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowRightIcon } from "@starterkit/ui/ui/icons";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import type { ResultColumn, ResultMemberDto, ResultMembersDto, ResultRowDto } from "@starterkit/shared/contracts/results";
import { BRAND } from "@starterkit/shared/brand";
import { api } from "@/lib/client/api";
import { amountText } from "@/lib/shared/amount";
import { resultMembers } from "@/lib/shared/queries-recon";
import { cellKey, resultIcon } from "./result-model";

const ITEM_LABEL: Record<ResultMemberDto["status"], string> = { open: "Waiting", matched: "Matched", suggested: "Suggested", break: "Unmatch", closed: "Closed" };

function SideTable({ label, members, more, fields }: { label: string; members: readonly ResultMemberDto[]; more: number; fields: readonly ResultColumn[] }) {
  // the side's configured fields, but reference and amount (their own columns)
  const extra = fields.filter((c) => c.field !== "ext_ref" && c.field !== "amount_minor");
  return (
    <section aria-label={label} className="grid gap-2">
      <h3 className="text-title-3">{label} <span className="text-body-sm font-normal text-fg-3">{members.length + more === 1 ? "1 record" : `${members.length + more} records`}</span></h3>
      {members.length === 0 ? <p className="text-body-sm text-fg-2">No record of this side in this result.</p> : (
        <div className="rounded-md border border-line">
          <Table>
            <TableHeader><TableRow>
              <TableHead scope="col">Reference</TableHead><TableHead scope="col" className="text-right">Amount</TableHead><TableHead scope="col">Business date</TableHead>
              <TableHead scope="col">State</TableHead>{extra.map((c) => <TableHead key={cellKey(c)} scope="col">{c.label}</TableHead>)}
            </TableRow></TableHeader>
            <TableBody>{members.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-mono text-body-sm">{m.ref ?? "No reference"}</TableCell>
                <TableCell className="text-right whitespace-nowrap tabular">{amountText(m.amountMinor, m.currency)}{m.currency && <span className="ml-1 text-caption text-fg-3">{m.currency}</span>}</TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(appDayStart(m.businessDate))}</TableCell>
                <TableCell className="whitespace-nowrap">{ITEM_LABEL[m.status]}</TableCell>
                {extra.map((c) => <TableCell key={cellKey(c)}>{m.fields[cellKey(c)] ?? <span className="text-fg-3">–</span>}</TableCell>)}
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      )}
      {more > 0 && <p className="text-caption text-fg-3">{`And ${more} more not listed here.`}</p>}
    </section>
  );
}

/**
 * Explain (loaded on demand: next/dynamic): each side's records of one result with the recon's fields of that side,
 * and, for a group a run made, a link to that run (where its pass conditions show).
 */
export default function ExplainDialog({ spaceId, configId, row, sides, columns, onClose }: {
  spaceId: string; configId: string; row: ResultRowDto; sides: readonly [string, string]; columns: readonly ResultColumn[]; onClose: () => void;
}) {
  const m = resultMembers(spaceId, configId, row.id, row.kind);
  const q = useQuery({ queryKey: m.key, queryFn: () => api<ResultMembersDto>(m.url) });
  const chip = resultIcon(row.status).chip;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-200">
        <DialogHeader>
          <DialogTitle>{row.kind === "group" ? "Matched group" : "Item"}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2"><StatusChip health={chip.health} label={chip.label} />Business date {formatDate(appDayStart(row.businessDate))}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-section">
            {q.error ? <Failure title="Couldn't load the records" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} />
              : !q.data ? <div role="status" aria-label="Loading the records" className="grid gap-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
              : <>
                  <SideTable label={sides[0]} members={q.data.a} more={q.data.more.a} fields={columns.filter((c) => c.kind === "a")} />
                  <SideTable label={sides[1]} members={q.data.b} more={q.data.more.b} fields={columns.filter((c) => c.kind === "b")} />
                </>}
          </div>
        </DialogBody>
        <DialogFooter>
          {row.explain.runId && <Button asChild variant="link"><Link href={`/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(configId)}/runs/${encodeURIComponent(row.explain.runId)}`}>See how the run matched it<Icon icon={ArrowRightIcon} /></Link></Button>}
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
