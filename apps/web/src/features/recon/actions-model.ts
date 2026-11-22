import type { OpField } from "@starterkit/shared/integrations";
import { isTransform, type Source } from "@starterkit/shared/mapping";

// The Approval step's actions editor (stage 4), pure: an action as a sentence, a request's leaf fields with what fills
// them, the required ones a variant leaves empty, and typed changes (transforms) read back.

type ActionLike = { name: string; kind: "posting" | "notify"; on: { event: "level_approved"; level: number } | { event: "approved" } | { event: "rejected" } };
/** "When level 2 approves, send Status" / "When the change is approved, post Post to GL". */
export function actionSentence(a: ActionLike): string {
  const when = a.on.event === "level_approved" ? `When level ${a.on.level} approves` : a.on.event === "approved" ? "When the change is approved" : "When the change is rejected";
  return `${when}, ${a.kind === "posting" ? "post" : "send"} ${a.name}`;
}

type OpLike = { request: readonly OpField[]; fixed: readonly string[]; auto: readonly string[] };
export type Leaf = { path: string; required: boolean; filledBy: "fixed" | "auto" | null };
/** The request's leaf fields, in order, and whether the operation fills them itself (a fixed or auto value). */
export function requestLeaves(op: OpLike, fields: readonly OpField[] = op.request, prefix = ""): Leaf[] {
  return fields.flatMap((f) => {
    const path = `${prefix}${f.name}`;
    if (f.children?.length) return requestLeaves(op, f.children, `${path}.`);
    return [{ path, required: f.required, filledBy: op.fixed.includes(path) ? "fixed" as const : op.auto.includes(path) ? "auto" as const : null }];
  });
}

/** The required fields a variant's mapping leaves empty (the operation's fixed and auto ones fill themselves). */
export function mappingGaps(mapping: Readonly<Record<string, Source>>, op: OpLike): string[] {
  return requestLeaves(op).filter((l) => l.required && !l.filledBy && !(l.path in mapping)).map((l) => l.path);
}

/** Changes typed as "amount:minor, pad_left:16:0": the ones known, in order, and the ones not. */
export function parseTransforms(text: string): { list: string[]; bad: string[] } {
  const parts = text.split(",").map((t) => t.trim()).filter(Boolean);
  return { list: parts.filter(isTransform), bad: parts.filter((t) => !isTransform(t)) };
}
