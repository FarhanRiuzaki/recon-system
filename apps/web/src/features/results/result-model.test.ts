import { describe, expect, it } from "vitest";
import { RESULT_STATUS_LABEL, RESULT_STATUSES, type ResultStatus } from "@starterkit/shared/results";
import { statusTone } from "@/lib/shared/categories";
import { CheckIcon, CloseIcon, NoneIcon } from "@starterkit/ui/ui/icons";
import { SIDE_STATES } from "@starterkit/shared/results";
import { cellText, columnKey, pageState, pickRecon, RESULT_LEGEND, resultIcon, SIDE_HEADER, sideHelp, sideIcon } from "./result-model";

// the spec's table: green done, red failed or unmatch, amber needs a look, blue under way, grey nothing or off
const GREEN = statusTone("matched"), RED = statusTone("failed"), AMBER = statusTone("check"), BLUE = statusTone("in_progress"), GREY = statusTone("nothing");
const TONE: Record<ResultStatus, string> = {
  posting_failed: RED, posting_in_progress: BLUE, posting_skipped: AMBER, waiting_approval: BLUE, posted: GREEN, written_off: GREY, adjusted: GREY,
  closed: GREY, force_matched: GREEN, matched_by_hand: GREEN, matched_late: GREEN, suggested: AMBER, matched: GREEN, unmatch: RED, waiting_counterpart: BLUE,
};

describe("result icons", () => {
  it("every status has an icon and a chip in its spec tone, labelled with the status's words", () => {
    for (const s of RESULT_STATUSES) {
      const r = resultIcon(s);
      expect(r.icon, s).toBeTruthy();
      expect(r.chip.health, s).toBe(TONE[s]);
      expect(r.chip.label).toBe(RESULT_STATUS_LABEL[s]);
    }
  });
  it("statuses are told apart by their icon, not only their colour", () => {
    expect(new Set(RESULT_STATUSES.map((s) => resultIcon(s).icon)).size).toBe(RESULT_STATUSES.length);
  });
  it("a side: matched green, unmatch red, none grey, suggested amber; a count past one record", () => {
    expect(sideIcon({ state: "in_group", count: 3 })).toMatchObject({ chip: { health: GREEN }, count: "3 records" });
    expect(sideIcon({ state: "in_group", count: 1 }).count).toBeNull();
    expect(sideIcon({ state: "unmatch", count: 1 }).chip.health).toBe(RED);
    expect(sideIcon({ state: "none", count: 0 }).chip).toEqual({ health: GREY, label: "No record on this side" });
    // each side state draws its own icon: ✓ matched, ✕ unmatched, – none (owner 24 Nov)
    expect(sideIcon({ state: "in_group", count: 1 }).icon).toBe(CheckIcon);
    expect(sideIcon({ state: "unmatch", count: 1 }).icon).toBe(CloseIcon);
    expect(sideIcon({ state: "none", count: 0 }).icon).toBe(NoneIcon);
    expect(sideIcon({ state: "suggested", count: 1 }).chip.health).toBe(AMBER);
  });
});

describe("the recon shown", () => {
  const rs = [{ id: "r1", publishedVersion: null }, { id: "r2", publishedVersion: 1 }, { id: "r3", publishedVersion: 4 }];
  it("the one asked for while it has a published version, else the first (by name) that has one, else none", () => {
    expect(pickRecon(rs, "r3")).toBe("r3");
    expect(pickRecon(rs, "r1")).toBe("r2");
    expect(pickRecon(rs, null)).toBe("r2");
    expect(pickRecon([rs[0]!], "r1")).toBeNull();
  });
});

describe("cells", () => {
  const col = { kind: "a", field: "attrs.merchant", label: "Merchant" } as const;
  it("values that differ say how many; a field the source lost says so; none is a dash", () => {
    expect(cellText({ value: null, many: 3 }, col)).toBe("3 values");
    expect(cellText({ value: null, many: null, missing: true }, col)).toBe("Field not in the source");
    expect(cellText({ value: null, many: null }, col)).toBe("–");
    expect(cellText(undefined, col)).toBe("–");
    expect(cellText({ value: "M-0012", many: null }, col)).toBe("M-0012");
  });
  it("an amount in its currency's major units; Mixed over currencies stays Mixed", () => {
    const amount = { kind: "a", field: "amount_minor", label: "Amount" } as const;
    expect(cellText({ value: "100000", many: null, currency: "IDR" }, amount)).toBe("1,000.00 IDR");
    expect(cellText({ value: "Mixed", many: null, currency: null }, amount)).toBe("Mixed");
  });
  it("recon info as words: a posting status by its Posting words, a business date as a date", () => {
    expect(cellText({ value: "not_sent", many: null }, { kind: "recon", field: "postingStatus", label: "Posting" })).toBe("Not sent");
    expect(cellText({ value: "2026-11-24", many: null }, { kind: "recon", field: "businessDate", label: "Business date" })).toMatch(/^24 Nov/);
  });
  it("a column's table key is the same for the same field and fits the saved column choice", () => {
    expect(columnKey({ kind: "a", field: "attrs.merchant_id" })).toBe("a-attrs_merchant_id");
    expect(columnKey({ kind: "recon", field: "businessDate" })).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
  });
  it("two long fields that share their first 40 characters still get different keys, stable and within the shape", () => {
    const long = "attrs.settlement_reference_of_the_switch_";
    const [x, y] = [columnKey({ kind: "a", field: `${long}one` }), columnKey({ kind: "a", field: `${long}two` })];
    expect(x).not.toBe(y);
    for (const k of [x, y]) expect(k).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
    expect(columnKey({ kind: "a", field: `${long}one` })).toBe(x);
  });
});

describe("the side headers", () => {
  it("read Side A and Side B; the side's own name is what the header explains", () => {
    expect(SIDE_HEADER).toEqual(["Side A", "Side B"]);
    expect(sideHelp(1, ["BI-FAST switch · settlement", "Core banking · BI-FAST outgoing"])).toBe("Side B: Core banking · BI-FAST outgoing");
  });
});

describe("the page's state", () => {
  it("the recon list failing with no recon in the URL is an error to retry, not an empty page", () => {
    expect(pageState({ loaded: false, failed: true, published: 0 }, null)).toBe("error");
    expect(pageState({ loaded: false, failed: true, published: 0 }, "r1")).toBe("table");
    expect(pageState({ loaded: true, failed: false, published: 0 }, null)).toBe("none");
    expect(pageState({ loaded: true, failed: false, published: 2 }, "r1")).toBe("table");
    expect(pageState({ loaded: false, failed: false, published: 0 }, null)).toBe("table");
  });
});

describe("the card legend", () => {
  it("names every overall status and every side state once, each with the icon the table draws", () => {
    expect(RESULT_LEGEND).toHaveLength(RESULT_STATUSES.length + SIDE_STATES.length);
    expect(new Set(RESULT_LEGEND.map((l) => l.label)).size).toBe(RESULT_LEGEND.length);
    expect(RESULT_LEGEND.every((l) => !!l.icon)).toBe(true);
  });
});
