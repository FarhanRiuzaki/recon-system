"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@starterkit/ui/ui/button";
import type { DateRange } from "@starterkit/ui/lib/date-range";
import { toast } from "@starterkit/ui/ui/toast";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { api, errorText } from "@/lib/client/api";
import { ENGINE_KEY } from "@/lib/shared/queries";
import { ReplayRange } from "./replay-range";
import { defaultReplay, pastClose, rangeText } from "./run-model";
import { reconApi, reconRunHref, useReplayDefault } from "./use-recons";

/**
 * "Run recon" on a published version's Overview (Captain): business dates (at most 31, as a simulation) and the run,
 * then its page. Dates past close become breaks where nothing pairs their items, which can't be undone: one sentence
 * of fact asks first. A closed date is refused by the API (a rerun with approval, later), its sentence a toast.
 */
export function RunControl({ spaceId, id, spec }: { spaceId: string; id: string; spec: ReconSpec }) {
  // the dates a run starts with: what the operator picked, else a date both sides have records on (useReplayDefault)
  const [picked, setRange] = useState<DateRange | null>(null);
  const replay = useReplayDefault(spaceId, spec);
  const range = picked ?? replay.suggested ?? defaultReplay();
  const gap = replay.gap(range);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const past = pastClose(spec, range);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<ReconRunDto>(reconApi(spaceId, id, "/runs"), { method: "POST", body: JSON.stringify(range) });
      await qc.invalidateQueries({ queryKey: ENGINE_KEY });
      router.push(reconRunHref(spaceId, id, r.id));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const days = (n: number) => (n === 1 ? "1 day is past close; its open items stay unmatched." : `${n} days are past close; their open items stay unmatched.`);
  return (
    <section aria-label="Run recon" className="flex flex-wrap items-center justify-end gap-2">
      <ReplayRange label="Dates" value={range} onChange={setRange} disabled={busy} />
      <Button type="button" disabled={busy} onClick={() => (past ? setAsking(true) : void start())}>Run recon</Button>
      {gap && (
        <p className="flex basis-full flex-wrap items-center justify-end gap-x-3 gap-y-1 text-body-sm text-fg-2">
          <span>{gap}</span>
          {replay.suggested && (replay.suggested.from !== range.from || replay.suggested.to !== range.to) && !busy && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setRange(replay.suggested)}>Run {rangeText(replay.suggested.from, replay.suggested.to)}</Button>
          )}
        </p>
      )}
      {asking && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setAsking(false); }} auditFields={false} reasons={[]}
          title="Run this recon?" description={`Runs ${rangeText(range.from, range.to)}. ${days(past)}`}
          impact={[]} actionLabel="Run recon" onConfirm={async () => { setAsking(false); await start(); }} />
      )}
    </section>
  );
}
