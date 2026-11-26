import { describe, expect, it } from "vitest";
import { readMark, readOutcome } from "./read-watch";

type Pull = { at: string; status: "new" | "nothing_new" | "failed" | "paused"; added: number; leftOut: number; quarantined: number; error: string | null };
const pull = (o: Partial<Pull> = {}): Pull => ({ at: "2026-11-26T09:36:08.955Z", status: "new", added: 4, leftOut: 0, quarantined: 0, error: null, ...o });
const src = (o: { kind?: "db_watermark" | "db_snapshot" | "file_inbox"; status?: "active" | "paused"; lastPull?: Pull | null; lastReadAt?: string | null; lastError?: string | null } = {}) => ({
  kind: o.kind ?? "db_watermark", status: o.status ?? "active", lastPull: o.lastPull === undefined ? pull() : o.lastPull,
  health: { lastReadAt: o.lastReadAt ?? "2026-11-26T09:36:09.042Z", lastError: o.lastError ?? null },
}) as Parameters<typeof readMark>[0];

describe("a read the source page watches to its end", () => {
  it("ends when its last pull, last good read, error or status changes; nothing else counts", () => {
    const before = readMark(src());
    expect(readMark(src())).toBe(before);
    expect(readMark(src({ lastPull: pull({ at: "2026-11-26T09:40:00.000Z" }) }))).not.toBe(before);
    expect(readMark(src({ lastPull: pull({ status: "nothing_new" }) }))).not.toBe(before);
    expect(readMark(src({ kind: "db_snapshot", lastPull: null, lastReadAt: "2026-11-26T10:00:00.000Z" }))).not.toBe(readMark(src({ kind: "db_snapshot", lastPull: null })));
    expect(readMark(src({ lastError: "Login refused" }))).not.toBe(before);
    expect(readMark(src({ status: "paused" }))).not.toBe(before);
  });

  it("announces a pull by what it stored, a failure or a pause as an error", () => {
    expect(readOutcome(src())).toEqual({ ok: true, text: "Pull finished: 4 new records." });
    expect(readOutcome(src({ lastPull: pull({ added: 1, leftOut: 2, quarantined: 1 }) }))).toEqual({ ok: true, text: "Pull finished: 1 new record, 2 rows left out, 1 line quarantined." });
    expect(readOutcome(src({ lastPull: pull({ status: "nothing_new", added: 0 }) }))).toEqual({ ok: true, text: "Pull finished: nothing new since the last pull." });
    expect(readOutcome(src({ lastPull: pull({ status: "failed", error: "Rollback not done: business date 2026-11-25 is signed off." }) })))
      .toEqual({ ok: false, text: "The pull failed: Rollback not done: business date 2026-11-25 is signed off." });
    expect(readOutcome(src({ status: "paused", lastError: "column amount was dropped" }))).toEqual({ ok: false, text: "The source paused: column amount was dropped. Approve a new version to start it again." });
  });

  it("a snapshot or a folder check: its error, else that the records are up to date", () => {
    expect(readOutcome(src({ kind: "db_snapshot", lastPull: null }))).toEqual({ ok: true, text: "Pull finished. The records are up to date." });
    expect(readOutcome(src({ kind: "file_inbox", lastPull: null }))).toEqual({ ok: true, text: "Folder check finished. The files and records are up to date." });
    expect(readOutcome(src({ kind: "db_snapshot", lastPull: null, lastError: "Timed out" }))).toEqual({ ok: false, text: "The read failed: Timed out" });
  });
});
