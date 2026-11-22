import type { OperationSpec } from "@starterkit/shared/contracts/integrations";
import { fieldPaths } from "@starterkit/shared/integrations";

// A connector draft's operations as the editor changes them (DEC-053), pure: a field renamed carries what points to it,
// what points to a field that is gone is dropped before saving, and an operation is changed by its place in the list.

const moved = (p: string, from: string, to: string) => (p === from ? to : p.startsWith(`${from}.`) ? `${to}${p.slice(from.length)}` : p);

/** `op` with every path at or under `from` (fixed values, masks, success rule, reference) moved to `to`. */
export function renamePath(op: OperationSpec, from: string, to: string): OperationSpec {
  if (!from || from === to) return op;
  return {
    ...op,
    presets: Object.fromEntries(Object.entries(op.presets).map(([k, v]) => [moved(k, from, to), v])),
    masked: op.masked.map((p) => moved(p, from, to)),
    success: op.success ? { ...op.success, field: moved(op.success.field, from, to) } : null,
    reference: op.reference ? moved(op.reference, from, to) : null,
  };
}

/** `op` without fixed values, masks, a success rule or a reference that point to a field it no longer has. */
export function prune(op: OperationSpec): OperationSpec {
  const req = new Set(fieldPaths(op.request)), res = new Set(fieldPaths(op.response));
  return {
    ...op,
    presets: Object.fromEntries(Object.entries(op.presets).filter(([k]) => req.has(k))),
    masked: op.masked.filter((p) => req.has(p) || res.has(p)),
    success: op.success && res.has(op.success.field) ? op.success : null,
    reference: op.reference && res.has(op.reference) ? op.reference : null,
  };
}

/** `list` with the item at `i` replaced. */
export const replaceAt = <T>(list: readonly T[], i: number, v: T): T[] => list.map((x, j) => (j === i ? v : x));
