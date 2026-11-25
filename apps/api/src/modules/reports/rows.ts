// A report's rows (spec "Making a file"): the recon's Operation result rows of the dates, read in keyset pages through
// the engine (no transaction held for the whole file: the pool's timeouts forbid it), filtered by the template's rows
// settings, cells for its columns, customer data masked unless the version shows it in full.
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import type { ResultColumn, ResultRowDto } from "@starterkit/shared/contracts/results";
import type { Tx } from "../../kernel/db";
import { reportResultRows } from "../engine";
import { withSpace } from "../spaces";
import { maskValue } from "./mask";
import type { ReportRow } from "./summary";

/** The columns the summary reads besides the template's own. */
const SUMMARY_KEYS = ["a:amount_minor", "recon:reason"];
const AMOUNT = "a:amount_minor";

/** A column key (`a:ext_ref`, `recon:reason`) as the engine's result column. */
export function columnOf(key: string): ResultColumn {
  const [kind, ...rest] = key.split(":");
  const field = rest.join(":");
  return kind === "recon" ? { kind: "recon", field: field as never, label: field } : { kind: kind as "a" | "b", field, label: field };
}

const keep = (spec: ReportSpec, r: ResultRowDto) =>
  (spec.rows.side === "both" || r[spec.rows.side].state !== "none")
  && (!spec.rows.reasons.length || spec.rows.reasons.includes(r.cells["recon:reason"]?.value ?? ""));

/** The engine's row as the report reads it, masked per `customer` (the recon's customer-data columns) unless full. */
export function toReportRow(r: ResultRowDto, keys: string[], customer: Set<string>, masking: "masked" | "full"): ReportRow {
  const values = Object.fromEntries(keys.map((k) => {
    const v = r.cells[k]?.value ?? null;
    return [k, v !== null && masking === "masked" && customer.has(k) ? maskValue(v) : v];
  }));
  const amount = r.cells[AMOUNT]?.value;
  return {
    date: r.businessDate, status: r.status, values,
    amount: amount && /^-?\d+$/.test(amount) ? BigInt(amount) : null, currency: r.cells[AMOUNT]?.currency ?? null, reason: r.cells["recon:reason"]?.value ?? null,
  };
}

/**
 * The rows of `from`..`to` in pages of `pageSize` (business date, then row), each page as ReportRows. `on` = the
 * worker's pool (or the test's); every page is its own transaction in the space.
 */
export async function* reportRows(on: Tx, spaceId: string, configId: string, spec: ReportSpec, from: string, to: string, pageSize = 2000): AsyncGenerator<ReportRow[]> {
  const keys = [...new Set([...spec.columns.map((c) => c.key), ...spec.groups, ...spec.totals.flatMap((t) => (t.column ? [t.column] : [])), ...SUMMARY_KEYS])];
  const columns = keys.map(columnOf);
  let after: { bd: string; rowId: string } | null = null;
  for (;;) {
    const page = await withSpace({ spaceIds: [spaceId], userId: null }, (tx) => reportResultRows(tx, spaceId, configId, [from, to], { statuses: spec.rows.statuses, columns }, after, pageSize), on);
    if (!page.rows.length) return;
    yield page.rows.filter((r) => keep(spec, r)).map((r) => toReportRow(r, keys, page.customer, spec.output.masking));
    if (page.rows.length < pageSize) return;
    after = page.last;
  }
}
