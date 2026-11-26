// A read the viewer just asked for (Pull now, a folder check, a snapshot pull, a rollback that waits for the next pull)
// runs as a job; the source page watches it to its end (use-sources.ts useWatchedSource). Pure: what marks a read as
// ended, and the sentence its end announces.
import type { SourceDto } from "@starterkit/shared/contracts/sources";
import { formatNumber } from "@starterkit/ui/lib/format";

type Read = Pick<SourceDto, "kind" | "status" | "lastPull"> & { health: Pick<NonNullable<SourceDto["health"]>, "lastReadAt" | "lastError"> | null };

/** How often a watched source is read again, and how long at most (a read that takes longer shows in the history's own refresh). */
export const READ_POLL_MS = 3_000;
export const READ_WATCH_MAX_MS = 10 * 60_000;

/** What a source's last read left: its last pull, its last good read, its error and status. Any read that ends changes it. */
export const readMark = (s: Read): string =>
  JSON.stringify([s.status, s.lastPull?.at ?? null, s.lastPull?.status ?? null, s.health?.lastReadAt ?? null, s.health?.lastError ?? null]);

const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** The sentence a read that just ended announces, from the source as it stands now; `ok` false = an error toast. */
export function readOutcome(s: Read): { ok: boolean; text: string } {
  if (s.status === "paused") return { ok: false, text: `The source paused: ${s.health?.lastError ?? s.lastPull?.error ?? "its table changed"}. Approve a new version to start it again.` };
  const p = s.kind === "db_watermark" ? s.lastPull : null;
  if (p) {
    if (p.status === "failed") return { ok: false, text: `The pull failed: ${p.error ?? "no reason was given"}` };
    if (p.status === "nothing_new") return { ok: true, text: "Pull finished: nothing new since the last pull." };
    const more = [p.leftOut ? `${plural(p.leftOut, "row", "rows")} left out` : "", p.quarantined ? `${plural(p.quarantined, "line", "lines")} quarantined` : ""].filter(Boolean);
    return { ok: true, text: `Pull finished: ${plural(p.added, "new record", "new records")}${more.length ? `, ${more.join(", ")}` : ""}.` };
  }
  if (s.health?.lastError) return { ok: false, text: `The read failed: ${s.health.lastError}` };
  return { ok: true, text: s.kind === "file_inbox" ? "Folder check finished. The files and records are up to date." : "Pull finished. The records are up to date." };
}
