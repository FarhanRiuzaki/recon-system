import { describe, expect, it } from "vitest";
import { BREAK_ACTION_STATUSES } from "./contracts/breaks";
import { ResultColumnsBody, ResultListQuery } from "./contracts/results";
import { GROUP_KINDS, ITEM_STATUSES, RESOLUTIONS } from "./recon";
import { RESULT_STATUSES, resultStatus, type ResultInput } from "./results";

const none: ResultInput = { groupKind: null, resolution: null, itemStatus: null, proposed: false, pendingRequest: false, posting: null };
const st = (x: Partial<ResultInput>) => resultStatus({ ...none, ...x });

describe("resultStatus (the spec's table, first that holds)", () => {
  it("answers a status for every combination the tables allow", () => {
    const seen = new Set<string>();
    for (const groupKind of [null, ...GROUP_KINDS]) for (const resolution of [null, ...RESOLUTIONS]) for (const itemStatus of [null, ...ITEM_STATUSES])
      for (const proposed of [false, true]) for (const pendingRequest of [false, true]) for (const posting of [null, ...BREAK_ACTION_STATUSES]) {
        const s = resultStatus({ groupKind, resolution, itemStatus, proposed, pendingRequest, posting });
        expect(RESULT_STATUSES).toContain(s);
        seen.add(s);
      }
    expect([...seen].sort()).toEqual([...RESULT_STATUSES].sort());
  });

  it("posting: an open group is in progress, never posted; failed, timeout, not sent fail; no rule or skipped is skipped", () => {
    expect(st({ resolution: "POSTED", posting: "grouped" })).toBe("posting_in_progress");
    expect(st({ resolution: "POSTED", posting: "sending" })).toBe("posting_in_progress");
    expect(st({ resolution: "POSTED", posting: "failed" })).toBe("posting_failed");
    expect(st({ resolution: "POSTED", posting: "timeout" })).toBe("posting_failed");
    expect(st({ resolution: "POSTED", posting: "no_rule" })).toBe("posting_skipped");
    expect(st({ resolution: "POSTED", posting: "posted" })).toBe("posted");
    expect(st({ resolution: "POSTED", posting: null })).toBe("posted");
    expect(st({ resolution: "WRITTEN_OFF", posting: "skipped" })).toBe("written_off");
  });

  it("the rest in the table's order", () => {
    expect(st({ groupKind: "auto", pendingRequest: true })).toBe("waiting_approval");
    expect(st({ groupKind: "force" })).toBe("force_matched");
    expect(st({ resolution: "FORCE_MATCHED" })).toBe("force_matched");
    expect(st({ groupKind: "manual" })).toBe("matched_by_hand");
    expect(st({ groupKind: "auto", resolution: "AUTO_MATCHED_LATE_DATA" })).toBe("matched_late");
    expect(st({ groupKind: "suggested" })).toBe("suggested");
    expect(st({ groupKind: "auto" })).toBe("matched");
    expect(st({ itemStatus: "break" })).toBe("unmatch");
    expect(st({ itemStatus: "break", proposed: true })).toBe("suggested");
    expect(st({ itemStatus: "open" })).toBe("waiting_counterpart");
    expect(st({ resolution: "ADJUSTED" })).toBe("adjusted");
    expect(st({ itemStatus: "closed" })).toBe("closed");
    expect(st({ itemStatus: "closed", resolution: "DUPLICATE" })).toBe("closed");
  });
});

describe("ResultListQuery", () => {
  const q = (s: Record<string, string>) => ResultListQuery.safeParse(s).success;
  it("takes a range of up to 31 days, refuses 32 and an end before the start", () => {
    expect(q({ dateFrom: "2026-11-01", dateTo: "2026-12-01" })).toBe(true);
    expect(q({ dateFrom: "2026-11-01", dateTo: "2026-12-02" })).toBe(false);
    expect(q({ dateFrom: "2026-11-02", dateTo: "2026-11-01" })).toBe(false);
    expect(q({})).toBe(true);
    expect(q({ dateFrom: "2026-02-30" })).toBe(false);
    expect(q({ result: "unmatch", sideA: "in_group" })).toBe(true);
    expect(q({ result: "lost" })).toBe(false);
  });
});

describe("ResultColumnsBody", () => {
  const col = (field: string) => ({ kind: "a", field, label: field });
  it("at most 20 columns, no column twice, labels 1–60 trimmed, fields a recon may name", () => {
    expect(ResultColumnsBody.safeParse({ columns: Array.from({ length: 20 }, (_, i) => col(`attrs.f${i}`)) }).success).toBe(true);
    expect(ResultColumnsBody.safeParse({ columns: Array.from({ length: 21 }, (_, i) => col(`attrs.f${i}`)) }).success).toBe(false);
    expect(ResultColumnsBody.safeParse({ columns: [col("ext_ref"), col("ext_ref")] }).success).toBe(false);
    expect(ResultColumnsBody.safeParse({ columns: [col("ext_ref"), { ...col("ext_ref"), kind: "b" }] }).success).toBe(true);
    expect(ResultColumnsBody.safeParse({ columns: [{ ...col("ext_ref"), label: "  " }] }).success).toBe(false);
    expect(ResultColumnsBody.safeParse({ columns: [col("Drop table")] }).success).toBe(false);
    expect(ResultColumnsBody.safeParse({ columns: [{ kind: "recon", field: "assignee", label: "Who" }] }).success).toBe(true);
    expect(ResultColumnsBody.safeParse({ columns: [{ kind: "recon", field: "ext_ref", label: "Who" }] }).success).toBe(false);
  });
});
