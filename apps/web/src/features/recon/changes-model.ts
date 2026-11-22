import { isTransform } from "@starterkit/shared/mapping";

// The changes a mapped value goes through (the engine's transforms), as chips picked from a menu instead of typed
// text (owner 22 Nov: "kurang clear"): each kind, the values it asks for, the transform it builds, and its words.

export type ChangeKind = { id: string; label: string; values: readonly { name: string; placeholder: string }[] };
export const CHANGE_KINDS: readonly ChangeKind[] = [
  { id: "date", label: "Date format", values: [{ name: "Pattern", placeholder: "yyyyMMdd" }] },
  { id: "amount:minor", label: "Amount in minor units", values: [] },
  { id: "amount:major", label: "Amount with decimals", values: [{ name: "Decimals", placeholder: "2" }] },
  { id: "pad_left", label: "Pad on the left", values: [{ name: "Length", placeholder: "16" }, { name: "Character", placeholder: "0" }] },
  { id: "pad_right", label: "Pad on the right", values: [{ name: "Length", placeholder: "16" }, { name: "Character", placeholder: " " }] },
  { id: "trim", label: "Trim spaces", values: [] },
  { id: "upper", label: "Upper case", values: [] },
  { id: "lower", label: "Lower case", values: [] },
  { id: "abs", label: "Without sign", values: [] },
  { id: "truncate_left", label: "Keep the last characters", values: [{ name: "Count", placeholder: "20" }] },
  { id: "truncate_right", label: "Keep the first characters", values: [{ name: "Count", placeholder: "20" }] },
  { id: "default", label: "A value when empty", values: [{ name: "Value", placeholder: "-" }] },
];

/** The transform of kind `id` with `values`, or null when the engine wouldn't take it. */
export function changeOf(id: string, values: readonly string[]): string | null {
  const t = [id, ...values].join(":");
  return isTransform(t) ? t : null;
}

/** A transform's kind and values ("date:dd/MM/yyyy HH:mm" keeps its colons: one value). */
export function partsOf(t: string): { kind: string; values: string[] } {
  const kind = CHANGE_KINDS.map((k) => k.id).filter((id) => t === id || t.startsWith(`${id}:`)).sort((a, b) => b.length - a.length)[0] ?? t;
  const k = CHANGE_KINDS.find((x) => x.id === kind);
  const rest = t.length > kind.length ? t.slice(kind.length + 1) : "";
  if (!k || !k.values.length) return { kind, values: [] };
  if (k.values.length === 1) return { kind, values: [rest] };
  const at = rest.indexOf(":");
  return { kind, values: [rest.slice(0, at), rest.slice(at + 1)] };
}

/** A transform in words. */
export function changeText(t: string): string {
  const { kind, values: [a, b] } = partsOf(t);
  switch (kind) {
    case "date": return `Date as ${a}`;
    case "amount:major": return `Amount with ${a} decimals`;
    case "pad_left": return `Pad left to ${a} with “${b}”`;
    case "pad_right": return `Pad right to ${a} with “${b}”`;
    case "truncate_left": return `Keep the last ${a}`;
    case "truncate_right": return `Keep the first ${a}`;
    case "default": return `“${a}” when empty`;
    default: return CHANGE_KINDS.find((k) => k.id === kind)?.label ?? t;
  }
}
