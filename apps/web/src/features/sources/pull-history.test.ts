import { describe, expect, it } from "vitest";
import type { SourcePullDto } from "@starterkit/shared/contracts/sources";
import { rollbackImpact } from "./pull-history";

const pull = (id: string, o: Partial<SourcePullDto> = {}): SourcePullDto => ({
  id, startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:00:01.000Z", status: "new", rows: 3, added: 3, quarantined: 0, leftOut: 0,
  watermark: null, error: null, rolledBackAt: null, rollback: "available", ...o,
});

describe("what rolling back a pull removes (Pull history)", () => {
  it("the pull and every later one that stored rows, newest first in the list; earlier ones and rolled back ones stay out", () => {
    const pulls = [
      pull("p5", { added: 2, quarantined: 1 }),
      pull("p4", { status: "nothing_new", rows: 3, added: 0, rollback: null }), // its look back read again: stored nothing
      pull("p3", { added: 4 }),
      pull("p2", { rolledBackAt: "2026-11-25T09:00:00.000Z", rollback: null }),
      pull("p1", { added: 51 }),
    ];
    expect(rollbackImpact(pulls[2]!, pulls)).toEqual({ pulls: 2, records: 6, quarantined: 1 });
    expect(rollbackImpact(pulls[4]!, pulls)).toEqual({ pulls: 3, records: 57, quarantined: 1 });
    expect(rollbackImpact(pulls[0]!, pulls)).toEqual({ pulls: 1, records: 2, quarantined: 1 });
  });
});
