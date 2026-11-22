import type { CatalogField } from "@starterkit/shared/conditions";
import type { OpField } from "@starterkit/shared/integrations";
import { type Source, templateParts } from "@starterkit/shared/mapping";

// The action editor's field map as a graph (owner 22 Nov: "seperti setup ERD"), pure: the recon's fields as source
// tables, the operation's request as the target table, an edge per field a mapping reads, and what a drag from a row
// to a request field writes.

type Op = { request: readonly OpField[]; fixed: readonly string[]; auto: readonly string[] };
type Account = { key: string; label: string };
export type SourceId = "break" | "recon" | "side_a" | "side_b" | "approval" | "accounts";
export type SourceTable = { id: SourceId; title: string; caption: string | null; rows: { key: string; label: string }[] };
export type RequestRow = {
  path: string; name: string; depth: number; leaf: boolean; required: boolean; type: OpField["type"];
  /** The operation fills it itself (a fixed or auto value): no source may be connected. */
  filledBy: "fixed" | "auto" | null;
  /** The kind of source mapped to it, if any. */
  mapped: Source["kind"] | null;
};
export type MapEdge = { id: string; source: SourceId; row: string; target: string; label: string | null };

const TITLE: Record<SourceId, string> = { break: "Break", recon: "Recon", side_a: "Side A", side_b: "Side B", approval: "Approval", accounts: "Accounts" };
const ORDER: SourceId[] = ["break", "recon", "side_a", "side_b", "approval", "accounts"];
/** "Source · file · Field" → its field, and where it comes from. */
const split = (label: string) => { const p = label.split(" · "); return { name: p.at(-1)!, from: p.length > 1 ? p.slice(0, -1).join(" · ") : null }; };

function requestRows(op: Op, fields: readonly OpField[], mapping: Readonly<Record<string, Source>>, prefix = "", depth = 0): RequestRow[] {
  return fields.flatMap((f) => {
    const path = `${prefix}${f.name}`;
    const leaf = !f.children?.length;
    const row: RequestRow = {
      path, name: f.name, depth, leaf, required: f.required, type: f.type,
      filledBy: !leaf ? null : op.fixed.includes(path) ? "fixed" : op.auto.includes(path) ? "auto" : null, mapped: mapping[path]?.kind ?? null,
    };
    return leaf ? [row] : [row, ...requestRows(op, f.children!, mapping, `${path}.`, depth + 1)];
  });
}

/** The graph of one variant's mapping over its operation. */
export function mapGraph(mapping: Readonly<Record<string, Source>>, catalog: readonly CatalogField[], op: Op, accounts: readonly Account[]) {
  const sources: SourceTable[] = ORDER.flatMap((id): SourceTable[] => {
    if (id === "accounts") return accounts.length ? [{ id, title: TITLE[id], caption: null, rows: accounts.map((a) => ({ key: `accounts.${a.key}`, label: a.label || a.key })) }] : [];
    const fs = catalog.filter((f) => f.group === id);
    if (!fs.length) return [];
    const froms = [...new Set(fs.map((f) => split(f.label).from))];
    return [{ id, title: TITLE[id], caption: froms.length === 1 ? froms[0]! : null, rows: fs.map((f) => ({ key: f.key, label: froms.length === 1 ? split(f.label).name : f.label })) }];
  });
  const tableOf = (key: string): SourceId | null =>
    key.startsWith("accounts.") ? "accounts" : (catalog.find((f) => f.key === key)?.group as SourceId | undefined) ?? null;
  const edges: MapEdge[] = [];
  const add = (row: string, target: string, label: string | null) => {
    const source = tableOf(row);
    if (source && !edges.some((e) => e.row === row && e.target === target)) edges.push({ id: `${row}>${target}`, source, row, target, label });
  };
  for (const [target, s] of Object.entries(mapping)) {
    if (s.kind === "field") add(s.key, target, s.transforms.length ? s.transforms.join(", ") : null);
    else if (s.kind === "account") add(`accounts.${s.account}`, target, s.part === "number" ? null : s.part);
    else if (s.kind === "lookup" && s.key.kind === "field") add(s.key.key, target, `lookup ${s.table}`);
    else if (s.kind === "template") for (const p of templateParts(s.text)) add(p.field ? p.field.key : `accounts.${p.account!.key}`, target, "template");
  }
  const request = requestRows(op, op.request, mapping);
  return { sources, request, edges, missing: request.filter((r) => r.leaf && r.required && !r.filledBy && !r.mapped).map((r) => r.path) };
}

/**
 * Row `key` (a catalog field or `accounts.<key>`) dragged onto request field `target`: the mapping with that source,
 * replacing any other; null when the target takes no source (a header, or a field the operation fills itself).
 */
export function connect(mapping: Readonly<Record<string, Source>>, key: string, target: string, op: Op): Record<string, Source> | null {
  const row = requestRows(op, op.request, mapping).find((r) => r.path === target);
  if (!row?.leaf || row.filledBy) return null;
  const now = mapping[target];
  if (now?.kind === "field" && now.key === key) return mapping as Record<string, Source>;
  const src: Source = key.startsWith("accounts.") ? { kind: "account", account: key.slice("accounts.".length), part: "number" } : { kind: "field", key, transforms: [] };
  return { ...mapping, [target]: src };
}

/** The mappings another operation still takes (fields it has, not filled by itself). */
export function keepMapping(mapping: Readonly<Record<string, Source>>, op: Op): Record<string, Source> {
  const open = new Set(requestRows(op, op.request, {}).filter((r) => r.leaf && !r.filledBy).map((r) => r.path));
  return Object.fromEntries(Object.entries(mapping).filter(([p]) => open.has(p)));
}
