// The designer's Data pane (spec 2026-11-26 "Template, data and ownership"): the fields of a dataset of the
// template's recon. Results and Items: the recon's own fields, then each side's source record (core fields, then the
// attributes of the source's published version) under "<side label> · <source name>"; Recap: its own fields.
// Customer data: every account, the recon's result columns marked so (the recon's rule), and source attributes
// marked so in their source's mapping.
import type { ReportFieldDto, ReportFieldsDto } from "@starterkit/shared/contracts/reports";
import { fieldName } from "@starterkit/shared/conditions";
import { CORE_FIELDS, recordFields } from "@starterkit/shared/recon";
import type { ReportDataset } from "@starterkit/shared/reports";
import { RECON_INFO_FIELDS, RECON_INFO_LABEL } from "@starterkit/shared/results";
import type { InTx } from "../../kernel/db";
import { resultColumnsOf } from "../recon";
import { readableSources } from "../sources";
import { sideGroupLabel } from "./rules";

const RECAP: [string, string, ReportFieldDto["type"]][] = [
  ["date", "Business date", "date"], ["currency", "Currency", "text"], ["results", "Results", "number"], ["matched", "Matched", "number"], ["breaks", "Breaks", "number"],
  ["match_rate", "Match rate (%)", "number"], ["count_a", "Side A count", "number"], ["amount_a", "Side A amount", "number"], ["count_b", "Side B count", "number"], ["amount_b", "Side B amount", "number"],
];
const KIND_TYPE: Record<string, ReportFieldDto["type"]> = { decimal: "number", integer: "number", number: "number", date: "date", datetime: "date" };

/** The catalog of `dataset` for recon `configId`. */
export async function fieldCatalog(tx: InTx, spaceId: string, configId: string, dataset: ReportDataset): Promise<ReportFieldsDto> {
  if (dataset === "recap") return { groups: [{ label: "Daily recap", fields: RECAP.map(([f, label, type]) => ({ ref: `recap:${f}`, label, type, customer: false })) }] };
  const rc = await resultColumnsOf(tx, spaceId, configId);
  const flagged = new Set(rc.columns.filter((c) => c.kind !== "recon" && c.customer).map((c) => `${c.kind}:${c.field}`));
  const recon: ReportFieldDto[] = [
    { ref: "recon:status", label: "Status", type: "status", customer: false },
    // an item row carries its side, its own status, its business date and its reason; the other info is a result's
    ...(dataset === "items"
      ? [{ ref: "recon:side", label: "Side", type: "text", customer: false } as const, { ref: "recon:item_status", label: "Item status", type: "status", customer: false } as const,
        { ref: "recon:businessDate", label: RECON_INFO_LABEL.businessDate, type: "date", customer: false } as const, { ref: "recon:reason", label: RECON_INFO_LABEL.reason, type: "text", customer: false } as const]
      : RECON_INFO_FIELDS.map((f): ReportFieldDto => ({ ref: `recon:${f}`, label: RECON_INFO_LABEL[f], type: f === "businessDate" || f === "resolvedAt" ? "date" : f === "pass" ? "number" : "text", customer: false }))),
  ];
  const groups: ReportFieldsDto["groups"] = [{ label: dataset === "items" ? "Item" : "Result", fields: recon }];
  const spec = rc.spec;
  if (!spec) return groups.length ? { groups } : { groups: [] };
  const found = await readableSources(tx, spaceId, [...new Set(spec.sides.map((s) => s.source_id))]);
  spec.sides.forEach((side, i) => {
    const k = i === 0 ? "a" : "b";
    const src = found.get(side.source_id);
    if (!src?.spec) return;
    const customerAttrs = new Set(((src.spec.mapping as { customer?: string[] }).customer ?? []).map((n) => `attrs.${n}`));
    const fields = [...recordFields(src.spec).entries()].map(([f, rf]): ReportFieldDto => ({
      ref: `${k}:${f}`,
      // an attribute has no label of its own: its name said in words ("receiver_bank" → "Receiver bank")
      label: fieldName(f),
      type: f in CORE_FIELDS ? (CORE_FIELDS[f as keyof typeof CORE_FIELDS] === "decimal" ? "number" : CORE_FIELDS[f as keyof typeof CORE_FIELDS] === "date" ? "date" : "text") : KIND_TYPE[rf.kind] ?? "text",
      customer: f === "account_ref" || flagged.has(`${k}:${f}`) || customerAttrs.has(f),
    }));
    groups.push({ label: sideGroupLabel(side.label, src.name), fields });
  });
  // Items: the same fields side-neutral (item:…), read from whichever side the item is on
  if (dataset === "items") {
    const seen = new Map<string, ReportFieldDto>();
    for (const g of groups.slice(1)) for (const f of g.fields) {
      const ref = `item:${f.ref.slice(2)}`;
      const was = seen.get(ref);
      seen.set(ref, { ...f, ref, customer: f.customer || !!was?.customer });
    }
    groups.splice(1, 0, { label: "Item record (either side)", fields: [...seen.values()] });
  }
  return { groups };
}

/** Every ref of the catalog (what preview checks a column against). */
export const catalogRefs = (c: ReportFieldsDto) => new Set(c.groups.flatMap((g) => g.fields.map((f) => f.ref)));
