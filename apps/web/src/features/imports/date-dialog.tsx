"use client";

import { Failure, StatusChip } from "@starterkit/ui/ds";
import { appDayStart, formatDate, formatDateTime, formatNumber } from "@starterkit/ui/lib/format";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@starterkit/ui/ui/dialog";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import { BRAND } from "@starterkit/shared/brand";
import type { ImportCheckDto, ImportHistoryDto } from "@starterkit/shared/contracts/imports";
import { DATE_DESCRIPTION, dateChip } from "./import-model";
import { useFeedDate } from "./use-imports";

const RESULT: Record<ImportCheckDto["result"], string> = {
  not_ready: "Source not ready", imported: "Imported", skipped: "Nothing new", failed: "Failed", dry_run: "Dry run",
};
const STATUS: Record<ImportHistoryDto["status"], string> = {
  PROCESSING: "Loading", IMPORTED: "Imported", FAILED: "Failed", SUPERSEDED: "Replaced", RERUN: "Set to rerun",
};
const at = (iso: string | null) => (iso ? formatDateTime(Date.parse(iso)) : "–");

/** One cell of Monitoring's grid opened: the date's state, every check of it and every history version. */
export function DateDialog({ feedId, feedName, date, onClose }: { feedId: string; feedName: string; date: string; onClose: () => void }) {
  const q = useFeedDate(feedId, date);
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const day = formatDate(appDayStart(date));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{feedName}, {day}</DialogTitle>
          <DialogDescription>{q.data ? DATE_DESCRIPTION[q.data.state] : "Every check of this MIS date and every batch in its history."}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-5">
          {q.error && !q.data && <Failure title="Couldn't load this date" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} />}
          {!q.data && !q.error && (skeleton ? <div className="grid gap-2" aria-hidden="true"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-20 w-full" /></div> : null)}
          {q.data && <>
            <div><StatusChip {...dateChip(q.data.state)} /></div>
            <section aria-label="History" className="grid gap-2">
              <h3 className="text-label text-fg">History</h3>
              {q.data.versions.length === 0 ? <p className="text-body-sm text-fg-3">No batch of this date in the history yet. One appears after the first run that finds the source ready.</p> : (
                <ul className="grid gap-2">
                  {q.data.versions.map((v) => (
                    <li key={v.id} className="grid gap-0.5 rounded-md border border-line px-3 py-2">
                      <span className="text-body-sm text-fg">{STATUS[v.status]} · {at(v.finishedAt ?? v.startedAt)}</span>
                      <span className="text-caption text-fg-3">
                        {v.totalRows !== null ? `${formatNumber(v.totalRows)} rows read, ${formatNumber(v.insertedRows ?? 0)} inserted, ${formatNumber(v.replacedRows ?? 0)} replaced` : `${formatNumber(v.fileSize)} rows read`}
                      </span>
                      {v.errorMessage && <span className="text-caption break-words text-down-ink">{v.errorMessage}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Checks" className="grid gap-2">
              <h3 className="text-label text-fg">Checks</h3>
              {q.data.checks.length === 0 ? <p className="text-body-sm text-fg-3">No check by this app yet. Checks appear once the feed&apos;s scheduler runs here.</p> : (
                <ul className="grid gap-1">
                  {q.data.checks.map((c) => (
                    <li key={c.id} className="text-body-sm text-fg-2">
                      {at(c.at)} · {RESULT[c.result]}{c.rows !== null ? `, ${formatNumber(c.rows)} rows` : ""}{c.by ? ` · ${c.by.name}` : ""}
                      {c.message && <span className="block text-caption break-words text-fg-3">{c.message}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
