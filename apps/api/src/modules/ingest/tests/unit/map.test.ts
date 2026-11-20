import { describe, expect, it } from "bun:test";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { fileDateOf, makeCalendar, signedAmount, toRecord } from "../../map";
import { parseText } from "../../parse";
import { idDefault, KSEI_FILE, ksei } from "./fixtures";

const cal = makeCalendar(idDefault);
const ctx = { calendar: cal, fileName: "act20261102.txt" };

describe("KSEI fixture through parse + toRecord", () => {
  it("12 lines: 10 records, 2 quarantined with per-column reasons", async () => {
    const spec = ksei();
    const lines = await parseText(KSEI_FILE, spec.input.kind === "file_inbox" ? spec.input.format : (null as never), spec.fields.map((f) => f.name));
    const records: unknown[] = [];
    const quarantine: Record<string, string>[] = [];
    for (const l of lines) {
      if (!l.ok) { quarantine.push(l.reasons); continue; }
      const r = toRecord(l.raw, spec, ctx);
      if (r.ok) records.push(r.record); else quarantine.push(r.reasons);
    }
    expect(records).toHaveLength(10);
    expect(quarantine).toEqual([{ _row: "Expected 14 columns, got 13" }, { sid: "sid is required" }]);
  });
  it("record: business_date from the file name, bday_index, attrs, natural key, row hash", () => {
    const raw = Object.fromEntries(ksei().fields.map((f, i) => [f.name, `v${i}`]));
    raw.sid = "TSTSID000000001";
    const r = toRecord(raw, ksei(), ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.reasons));
    expect(r.record).toMatchObject({ business_date: "2026-11-02", account_ref: "TSTSID000000001", attrs: { sre: "v2" }, natural_key: "TSTSID000000001", amount_minor: null });
    expect(r.record.row_hash).toMatch(/^[0-9a-f]{64}$/);
    // key order of the raw row does not change the hash
    const shuffled = Object.fromEntries(Object.entries(raw).reverse());
    const r2 = toRecord(shuffled, ksei(), ctx);
    expect(r2.ok && r2.record.row_hash).toBe(r.record.row_hash);
    const r3 = toRecord({ ...raw, col_01: "other" }, ksei(), ctx);
    expect(r3.ok && r3.record.row_hash).not.toBe(r.record.row_hash);
  });
});

describe("business_date sources", () => {
  const base = (): SourceSpec => ({
    fields: [
      { name: "ref", type: "string", nullable: false, trim: true },
      { name: "amt", type: "decimal", nullable: false, trim: true, format: { scale: 2 } },
      { name: "ccy", type: "string", nullable: true, trim: true, case: "upper" },
      { name: "ts", type: "datetime", nullable: true, trim: true, format: { date: "yyyy-MM-dd HH:mm:ss" } },
      { name: "d", type: "date", nullable: true, trim: true, format: { date: "yyyyMMdd" } },
    ],
    mapping: { business_date: { field: "d" }, amount_minor: { field: "amt" }, currency: { field: "ccy" }, event_time: { field: "ts" }, ext_ref: { field: "ref" }, attrs: { amt_text: { field: "amt" } } },
    derive: {},
    key_fields: ["ref", "d"],
    mutable: true,
    calendar: "id-default",
    input: { kind: "db_snapshot", query: "select 1 where :business_date is not null", schedule: "0 6 * * *" },
  });
  const raw = { ref: "R1", amt: "100.5", ccy: "idr", ts: "2026-11-02 23:30:00", d: "20261102" };

  it("from a field; amount in minor units; currency upper-cased; natural key joins the key fields", () => {
    const r = toRecord(raw, base(), ctx);
    if (!r.ok) throw new Error(JSON.stringify(r.reasons));
    expect(r.record).toMatchObject({ business_date: "2026-11-02", amount_minor: 10050n, currency: "IDR", ext_ref: "R1", event_time: "2026-11-02T16:30:00.000Z", natural_key: "R1\u001f2026-11-02", attrs: { amt_text: "100.50" } });
  });
  it("from a datetime field: the date in the field's timezone (23:30 Jakarta is still the 2nd)", () => {
    const s = base();
    s.mapping.business_date = { field: "ts" };
    const r = toRecord(raw, s, ctx);
    expect(r.ok && r.record.business_date).toBe("2026-11-02");
    const r2 = toRecord({ ...raw, ts: "2026-11-02 17:30:00" }, { ...s, fields: s.fields.map((f) => f.name === "ts" ? { ...f, format: { ...f.format, timezone: "UTC" } } : f) }, ctx);
    expect(r2.ok && r2.record.business_date).toBe("2026-11-02");
    const r3 = toRecord({ ...raw, ts: "2026-11-02 17:30:00" }, s, ctx); // 17:30 Jakarta = 10:30Z, same day
    expect(r3.ok && r3.record.business_date).toBe("2026-11-02");
  });
  it("from CEL over the row, and from a derived value", () => {
    const s = base();
    s.derive = { dd: 'row.d.substring(0, 4) + "-" + row.d.substring(4, 6) + "-" + row.d.substring(6, 8)' };
    s.mapping.business_date = { cel: 'row.d.substring(0, 4) + "-" + row.d.substring(4, 6) + "-" + row.d.substring(6, 8)' };
    expect((toRecord(raw, s, ctx) as { record: { business_date: string } }).record.business_date).toBe("2026-11-02");
    s.mapping.business_date = { field: "dd" };
    expect((toRecord(raw, s, ctx) as { record: { business_date: string } }).record.business_date).toBe("2026-11-02");
  });
  it("from the file name, or a CEL on file_name; missing file date is a reason", () => {
    const s = ksei();
    const r = { ...Object.fromEntries(s.fields.map((f) => [f.name, "x"])) };
    expect(toRecord(r, s, { calendar: cal, fileName: "act20261103.txt" })).toMatchObject({ ok: true, record: { business_date: "2026-11-03" } });
    expect(toRecord(r, s, { calendar: cal })).toMatchObject({ ok: false, reasons: { business_date: expect.stringContaining("file name") } });
    expect(fileDateOf("act20261102.txt")).toBe("2026-11-02");
    expect(fileDateOf("act20261302.txt")).toBeNull();
    expect(fileDateOf("report.txt")).toBeNull();
  });
  it("a derived value feeds amount_minor (integer minor units from CEL)", () => {
    const s = base();
    s.derive = { minor: 'int(row.ref.substring(1)) * 100' };
    s.mapping.amount_minor = { cel: "int(row.ref.substring(1)) * 100" };
    expect(toRecord(raw, s, ctx)).toMatchObject({ ok: true, record: { amount_minor: 100n } });
    s.mapping.amount_minor = { field: "minor" };
    s.key_fields = ["minor"];
    expect(toRecord(raw, s, ctx)).toMatchObject({ ok: true, record: { amount_minor: 100n, natural_key: "100" } });
  });
  it("reasons per column, all of them", () => {
    const r = toRecord({ ...raw, amt: "12,3x", d: "20261399", ref: "" }, base(), ctx);
    expect(r).toEqual({ ok: false, reasons: { amt: 'amt: not a decimal ("12,3x")', d: 'd: not a date ("20261399")', ref: "ref is required" } });
  });
});

describe("zones and amounts", () => {
  const spec = (): SourceSpec => ({
    fields: [
      { name: "ts", type: "datetime", nullable: false, trim: true, format: { timezone: "Mars/Olympus" } },
      { name: "amt", type: "decimal", nullable: false, trim: true, format: { scale: 2 } },
    ],
    mapping: { business_date: { field: "ts" }, amount_minor: { field: "amt" }, attrs: {} },
    derive: {}, key_fields: [], mutable: false, calendar: "id-default",
    input: { kind: "db_snapshot", query: "select 1 where :business_date is not null", schedule: "0 6 * * *" },
  });
  it("an unknown zone with an explicit offset is a reason, not a throw", () => {
    expect(toRecord({ ts: "2026-11-02T08:30:00+07:00", amt: "1" }, spec(), ctx)).toMatchObject({ ok: false, reasons: { business_date: expect.stringContaining("time zone") } });
  });
  it("amount_minor outside int64 is quarantined; the edge passes", () => {
    const s = spec();
    s.fields[0]!.format = { timezone: "UTC" };
    expect(toRecord({ ts: "2026-11-02T08:30:00Z", amt: "92233720368547758.07" }, s, ctx)).toMatchObject({ ok: true, record: { amount_minor: 9223372036854775807n } });
    expect(toRecord({ ts: "2026-11-02T08:30:00Z", amt: "92233720368547758.08" }, s, ctx)).toMatchObject({ ok: false, reasons: { amt: expect.stringContaining("out of range") } });
    expect(toRecord({ ts: "2026-11-02T08:30:00Z", amt: "99999999999999999999999" }, s, ctx)).toMatchObject({ ok: false });
  });
});

describe("amount unit and currency (spec §8: minor unit of the row's currency, ISO 4217)", () => {
  const spec = (type: "decimal" | "integer", unit?: "major" | "minor", scale = 3): SourceSpec => ({
    fields: [
      { name: "amount", type, nullable: false, trim: true, ...(type === "decimal" ? { format: { scale } } : {}) },
      { name: "ccy", type: "string", nullable: true, trim: true },
    ],
    mapping: { business_date: { cel: "'2026-11-02'" }, amount_minor: { field: "amount", ...(unit ? { unit } : {}) }, currency: { field: "ccy" }, attrs: {} },
    derive: {}, key_fields: [], mutable: false, calendar: "id-default",
    input: { kind: "db_snapshot", query: "select 1 where :business_date is not null", schedule: "0 6 * * *" },
  });
  const amount = (s: SourceSpec, amount: string, ccy: string | null) => {
    const r = toRecord({ amount, ccy }, s, ctx);
    return r.ok ? r.record.amount_minor : r.reasons;
  };
  it("major: scaled by the row's currency (IDR 2, USD 2, JPY 0, KWD 3)", () => {
    const s = spec("decimal", "major");
    expect(amount(s, "1500", "IDR")).toBe(150000n);
    expect(amount(s, "1500.5", "USD")).toBe(150050n);
    expect(amount(s, "1500", "JPY")).toBe(1500n);
    expect(amount(s, "1500.000", "JPY")).toBe(1500n);
    expect(amount(s, "1.234", "KWD")).toBe(1234n);
    expect(amount(spec("integer", "major"), "1500", "IDR")).toBe(150000n); // whole rupiah in an integer column
    expect(amount(spec("integer", "major"), "1500", "JPY")).toBe(1500n);
  });
  it("major: more decimals than the currency has is quarantined, never rounded", () => {
    const s = spec("decimal", "major");
    expect(amount(s, "1500.125", "IDR")).toEqual({ amount: 'amount: 3 decimal places; IDR allows 2 ("1500.125")' });
    expect(amount(s, "1500.5", "JPY")).toEqual({ amount: 'amount: 1 decimal place; JPY allows 0 ("1500.5")' });
    expect(amount(s, "1500", null)).toEqual({ amount: 'amount: no currency on this row to scale it by ("1500")' });
  });
  it("minor: a whole number as it is; a fraction is quarantined", () => {
    expect(amount(spec("integer", "minor"), "150000", "IDR")).toBe(150000n);
    expect(amount(spec("integer", "minor"), "1500", "JPY")).toBe(1500n);
    expect(amount(spec("integer", "minor"), "1234", "KWD")).toBe(1234n);
    expect(amount(spec("decimal", "minor"), "150000.00", "USD")).toBe(150000n);
    expect(amount(spec("decimal", "minor"), "150000.50", "USD")).toEqual({ amount: 'amount: 1 decimal place; minor units are whole numbers ("150000.50")' });
  });
  it("no unit (saved before it existed): an integer is minor, a decimal major — the same as then for IDR and USD", () => {
    expect(amount(spec("integer"), "2551779", "IDR")).toBe(2551779n);
    expect(amount(spec("decimal", undefined, 2), "25517.79", "USD")).toBe(2551779n);
    expect(amount(spec("decimal", undefined, 2), "1500", "JPY")).toBe(1500n); // was 150000: 100× too much
    const old = spec("decimal", undefined, 2);
    delete old.mapping.currency; // and no currency at all: the field's scale is the minor unit, as it was
    expect(toRecord({ amount: "100.5" }, old, ctx)).toMatchObject({ ok: true, record: { amount_minor: 10050n, currency: null } });
  });
  it("currency: case, spaces and ISO numeric codes are normalised; an unknown one is quarantined", () => {
    const s = spec("integer", "minor");
    const ccy = (c: string) => { const r = toRecord({ amount: "1", ccy: c }, s, ctx); return r.ok ? r.record.currency : r.reasons; };
    expect([ccy("idr"), ccy(" IDR "), ccy("360"), ccy("392"), ccy("048"), ccy("48")]).toEqual(["IDR", "IDR", "IDR", "JPY", "BHD", "BHD"]);
    expect(ccy("RPH")).toEqual({ ccy: 'ccy: "RPH" is not a currency code' });
    expect(ccy("999")).toEqual({ ccy: 'ccy: "999" is not a currency code' });
  });
  it("a fixed currency fills every row and scales its amount", () => {
    const s = spec("decimal", "major");
    delete s.mapping.currency;
    s.currency = "JPY";
    expect(toRecord({ amount: "1500" }, s, ctx)).toMatchObject({ ok: true, record: { amount_minor: 1500n, amount_text: "1500.000", currency: "JPY" } });
  });
  it("from CEL: an int or decimal text in the declared unit", () => {
    const s = spec("integer", "major");
    s.mapping.amount_minor = { cel: "'12.5'", unit: "major" };
    expect(amount(s, "0", "USD")).toBe(1250n);
    s.mapping.amount_minor = { cel: "'12.5'", unit: "minor" };
    expect(amount(s, "0", "USD")).toEqual({ amount_minor: 'amount_minor: 1 decimal place; minor units are whole numbers ("12.5")' });
  });
});

describe("bday_index", () => {
  const c = makeCalendar({ weekend: [6, 7], holidays: ["2026-11-04"] });
  it("counts business days: weekends and holidays share the previous index", () => {
    const i = (d: string) => c.bdayIndex(d);
    expect(i("2026-11-03")).toBe(i("2026-11-02") + 1); // Mon → Tue
    expect(i("2026-11-04")).toBe(i("2026-11-03")); // holiday Wed
    expect(i("2026-11-05")).toBe(i("2026-11-03") + 1);
    expect(i("2026-11-06")).toBe(i("2026-11-05") + 1); // Fri
    expect(i("2026-11-07")).toBe(i("2026-11-06")); // Sat
    expect(i("2026-11-08")).toBe(i("2026-11-06")); // Sun
    expect(i("2026-11-09")).toBe(i("2026-11-06") + 1); // Mon
  });
  it("a holiday on a weekend is not subtracted twice", () => {
    const w = makeCalendar({ weekend: [6, 7], holidays: ["2026-11-07"] });
    expect(w.bdayIndex("2026-11-09")).toBe(w.bdayIndex("2026-11-06") + 1);
  });
  it("a different weekend (Fri-Sat)", () => {
    const m = makeCalendar({ weekend: [5, 6], holidays: [] });
    expect(m.bdayIndex("2026-11-08")).toBe(m.bdayIndex("2026-11-05") + 1); // Thu → Sun
  });
});

describe("a database row's SQL NULL (connectors)", () => {
  it("types like an empty cell, but row_hash tells NULL from \"\"", () => {
    const spec = ksei();
    const raw = Object.fromEntries(spec.fields.map((f) => [f.name, "x"])) as Record<string, string | null>;
    raw.sid = "TSTSID000000001";
    const empty = toRecord({ ...raw, sre: "" }, spec, ctx);
    const nul = toRecord({ ...raw, sre: null }, spec, ctx);
    if (!empty.ok || !nul.ok) throw new Error("both map");
    expect([empty.record.attrs.sre, nul.record.attrs.sre]).toEqual([null, null]);
    expect(empty.record.natural_key).toBe(nul.record.natural_key);
    expect(empty.record.row_hash).not.toBe(nul.record.row_hash);
    expect(toRecord({ ...raw, sid: null }, spec, ctx)).toEqual({ ok: false, reasons: { sid: "sid is required" } });
  });

  it("a key field that is empty or NULL quarantines the row with that column's reason, even when the field may be empty", () => {
    const spec = { ...ksei(), key_fields: ["sid", "sre"] };
    const raw = Object.fromEntries(spec.fields.map((f) => [f.name, "x"])) as Record<string, string | null>;
    raw.sid = "TSTSID000000001";
    for (const sre of ["", "  ", null]) expect(toRecord({ ...raw, sre }, spec, ctx)).toEqual({ ok: false, reasons: { sre: "sre is required (a key field)" } });
  });
});

describe("the amount's sign: from direction when it is mapped, else from the amount (Plan 3)", () => {
  const spec = (withDirection: boolean): SourceSpec => ({
    fields: [
      { name: "amount", type: "decimal", nullable: false, trim: true, format: { scale: 2 } },
      { name: "dc", type: "string", nullable: true, trim: true },
    ],
    mapping: { business_date: { cel: "'2026-11-02'" }, amount_minor: { field: "amount", unit: "major" }, ...(withDirection ? { direction: { field: "dc" } } : {}), attrs: {} },
    currency: "IDR", derive: {}, key_fields: [], mutable: false, calendar: "id-default",
    input: { kind: "db_snapshot", query: "select 1 where :business_date is not null", schedule: "0 6 * * *" },
  });
  const map = (s: SourceSpec, amount: string, dc: string | null) => {
    const r = toRecord({ amount, dc }, s, ctx);
    return r.ok ? { amount: r.record.amount_minor, direction: r.record.direction, signed: signedAmount(r.record) } : r.reasons;
  };
  it("direction mapped: credit or debit as the source writes it, the amount never negative", () => {
    expect(map(spec(true), "15.00", "D")).toEqual({ amount: 1500n, direction: "debit", signed: -1500n });
    expect(map(spec(true), "15.00", " cr ")).toEqual({ amount: 1500n, direction: "credit", signed: 1500n });
    expect(map(spec(true), "15.00", "Kredit")).toEqual({ amount: 1500n, direction: "credit", signed: 1500n });
    expect(map(spec(true), "-15.00", "D")).toEqual({ amount: 'amount: negative, but direction is mapped; the sign comes from direction ("-15.00")' });
    expect(map(spec(true), "15.00", "X")).toEqual({ dc: 'dc: "X" is not a debit or a credit (D, DR, DB, DEBIT, DEBET or C, CR, K, CREDIT, KREDIT)' });
    expect(map(spec(true), "15.00", null)).toEqual({ dc: "dc: is empty; the amount's sign comes from it" });
  });
  it("no direction: the amount carries its own sign", () => {
    expect(map(spec(false), "-15.00", "D")).toEqual({ amount: -1500n, direction: null, signed: -1500n });
    expect(signedAmount({ amount_minor: null, direction: "debit" })).toBeNull();
  });
});
