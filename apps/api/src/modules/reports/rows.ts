// A report's data (spec 2026-11-26 "Template, data and ownership"): the recon's results, its items, or one row per
// business date and currency, read in keyset pages through the engine (no transaction held for the whole file: the
// pool's timeouts forbid it). Rows carry refs to values: `a:<field>` / `b:<field>` (the source record behind the row:
// core field or `attrs.<name>`), `recon:<field>` and `recap:<field>`; amounts in major units of their currency.
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import type { ResultColumn, ResultRowDto } from "@starterkit/shared/contracts/results";
import { RECON_INFO_FIELDS, type ResultStatus } from "@starterkit/shared/results";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import type { Tx } from "../../kernel/db";
import { reportResultRows } from "../engine";
import { withSpace } from "../spaces";
import type { DataRow } from "./cells";
import { fieldCatalog } from "./fields";
import { refsOf } from "./formula";

export const MATCHED: readonly ResultStatus[] = ["matched", "matched_late", "matched_by_hand", "force_matched"];
export const BREAKS: readonly ResultStatus[] = ["unmatch"];
const INFO = new Set<string>(RECON_INFO_FIELDS);

/** Every field the design reads: columns (with fallbacks and formulas), filters, groups and header lines. */
export function refsOfSpec(spec: ReportSpec): string[] {
  const out = new Set<string>();
  for (const c of spec.columns) {
    if (c.content.kind === "field") { out.add(c.content.ref); if (c.content.fallback) out.add(c.content.fallback); }
    if (c.content.kind === "formula") for (const r of refsOf(c.content.cel)) out.add(r);
  }
  for (const f of spec.rows.filters) out.add(f.ref);
  for (const g of spec.groups) out.add(g);
  for (const l of spec.sections.header.lines) if (l.value.kind === "field" || l.value.kind === "sum") out.add(l.value.ref);
  return [...out];
}

/** The engine's result column for a side's field or a recon info field (status and side come from the row itself). */
export function columnOf(ref: string): ResultColumn | null {
  const [kind, ...rest] = ref.split(":");
  const field = rest.join(":");
  if (kind === "a" || kind === "b") return { kind, field, label: field };
  if (kind === "recon" && INFO.has(field)) return { kind: "recon", field: field as never, label: field };
  return null;
}

/** An amount in minor units (text) as major units of `ccy`; another value as it is. */
export function major(field: string, v: string | null, ccy: string | null | undefined): string | number | null {
  if (v === null) return null;
  if (field !== "amount_minor" || !/^-?\d+$/.test(v)) return v;
  return Number(v) / 10 ** (CURRENCY_EXPONENT[(ccy ?? "").toUpperCase()] ?? 2);
}

function resultRow(r: ResultRowDto, refs: string[]): DataRow {
  const values: DataRow["values"] = {};
  for (const ref of refs) {
    if (ref === "recon:status") values[ref] = r.status;
    else if (ref === "recon:side") values[ref] = r.a.state !== "none" && r.b.state !== "none" ? "both" : r.a.state !== "none" ? "a" : "b";
    else if (ref === "recon:businessDate") values[ref] = r.businessDate;
    else { const c = r.cells[ref]; values[ref] = c ? major(ref.split(":").slice(1).join(":"), c.value, c.currency) : null; }
  }
  return { date: r.businessDate, values };
}

/** Whether `row` passes the design's filters (the status filter is pushed to the engine; the rest checked here). */
export function passes(spec: ReportSpec, row: DataRow): boolean {
  return spec.rows.filters.every((f) => {
    const raw = row.values[f.ref];
    const v = raw === null || raw === undefined ? "" : String(raw);
    switch (f.op) {
      case "is": return v === (f.value[0] ?? "");
      case "is_not": return v !== (f.value[0] ?? "");
      // a result on "a" holds side A's items whether or not side B has some (v1's side setting)
      case "any_of": return f.ref === "recon:side" ? f.value.some((s) => v === s || v === "both") : f.value.includes(v);
      case "contains": return v.toLowerCase().includes((f.value[0] ?? "").toLowerCase());
      case "empty": return v === "";
      case "not_empty": return v !== "";
      case "gt": return Number(raw) > Number(f.value[0]);
      case "lt": return Number(raw) < Number(f.value[0]);
    }
  });
}

type Page = { rows: DataRow[]; customer: Set<string> };

/**
 * The design's rows of `from`..`to` in pages of `pageSize`. Results: one per result (an item already written under
 * another row is dropped, final review I4); items: one per item, its fields under its side (`a:` or `b:`), the result's
 * status as `recon:status`, its own as `recon:item_status`; recap: one per date and currency (yielded at the end).
 */
export async function* datasetRows(on: Tx, spaceId: string, configId: string, spec: ReportSpec, from: string, to: string, pageSize = 2000): AsyncGenerator<Page> {
  const refs = spec.dataset === "recap"
    ? ["a:amount_minor", "b:amount_minor", "recon:status", "recon:side"]
    : [...new Set([...refsOfSpec(spec), "recon:status"])];
  const columns = refs.flatMap((r) => { const c = columnOf(r); return c ? [c] : []; });
  const statusFilter = spec.dataset === "recap" ? undefined : spec.rows.filters.find((f) => f.ref === "recon:status" && f.op === "any_of");
  const statuses = (statusFilter?.value ?? []) as ResultStatus[];
  // customer data: the engine's (accounts, the recon's marked columns) and the sources' marked attributes (the catalog's)
  const marked = await withSpace({ spaceIds: [spaceId], userId: null }, async (tx) =>
    new Set((await fieldCatalog(tx, spaceId, configId, spec.dataset)).groups.flatMap((g) => g.fields.filter((f) => f.customer).map((f) => f.ref))), on);
  const withMarked = (c: Set<string>) => new Set([...c, ...marked]);
  let after: { bd: string; rowId: string } | null = null;
  const seen = new Set<string>();
  const recap = new Map<string, Record<string, number | string>>();
  for (;;) {
    const page = await withSpace({ spaceIds: [spaceId], userId: null }, (tx) => reportResultRows(tx, spaceId, configId, [from, to], { statuses, columns }, after, pageSize), on);
    const fresh = page.rows.filter((r) => {
      const ids = page.items.get(r.id);
      if (!ids?.length) return true;
      if (ids.some((i) => seen.has(i))) return false;
      for (const i of ids) seen.add(i);
      return true;
    });
    if (spec.dataset === "results") yield { rows: fresh.map((r) => resultRow(r, refs)).filter((d) => passes(spec, d)), customer: withMarked(page.customer) };
    else if (spec.dataset === "items") {
      const keep = new Set(fresh.map((r) => r.id));
      const statusOf = new Map(fresh.map((r) => [r.id, r.status]));
      const rows = page.details.filter((i) => keep.has(i.rowId)).map((i): DataRow => {
        const values: DataRow["values"] = { "recon:side": i.side, "recon:status": statusOf.get(i.rowId) ?? null, "recon:item_status": i.status, "recon:businessDate": i.businessDate, "recon:reason": i.reason };
        for (const [f, v] of Object.entries(i.fields)) values[`${i.side}:${f}`] = major(f, v, i.fields.currency);
        return { date: i.businessDate, values };
      }).filter((d) => passes(spec, d));
      yield { rows, customer: withMarked(page.customer) };
    } else {
      for (const r of fresh) {
        const d = resultRow(r, refs);
        const ccy = r.cells["a:amount_minor"]?.currency ?? r.cells["b:amount_minor"]?.currency ?? "";
        const k = `${r.businessDate}|${ccy}`;
        const s = recap.get(k) ?? { "recap:date": r.businessDate, "recap:currency": ccy, "recap:results": 0, "recap:matched": 0, "recap:breaks": 0, "recap:count_a": 0, "recap:amount_a": 0, "recap:count_b": 0, "recap:amount_b": 0 };
        const add = (key: string, n: number) => { s[key] = (s[key] as number) + n; };
        add("recap:results", 1);
        if (MATCHED.includes(r.status)) add("recap:matched", 1);
        if (BREAKS.includes(r.status)) add("recap:breaks", 1);
        if (r.a.state !== "none") { add("recap:count_a", 1); add("recap:amount_a", typeof d.values["a:amount_minor"] === "number" ? d.values["a:amount_minor"] : 0); }
        if (r.b.state !== "none") { add("recap:count_b", 1); add("recap:amount_b", typeof d.values["b:amount_minor"] === "number" ? d.values["b:amount_minor"] : 0); }
        recap.set(k, s);
      }
    }
    if (page.rows.length < pageSize) break;
    after = page.last;
  }
  if (spec.dataset === "recap") {
    const rows = [...recap.values()].sort((x, y) => `${x["recap:date"]}|${x["recap:currency"]}`.localeCompare(`${y["recap:date"]}|${y["recap:currency"]}`)).map((s): DataRow => {
      const results = s["recap:results"] as number;
      return { date: s["recap:date"] as string, values: { ...s, "recap:match_rate": results ? Math.round(((s["recap:matched"] as number) / results) * 1000) / 10 : null } as DataRow["values"] };
    }).filter((d) => passes(spec, d));
    yield { rows, customer: new Set() };
  }
}
