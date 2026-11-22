// Approval workflows (DEC-052, docs/superpowers/specs/2026-11-22-approval-workflow-engine-design.md), zod-free: the
// actions a workflow binds to, the attributes its rules read, the limits, and the pure evaluation the API and the
// editor's "Who approves" share. A workflow = ordered rules; the first whose conditions all hold gives the chain of
// levels; a level passes when every group in it has its approvals (any / all / N of its eligible people).
import type { SpaceRole } from "./spaces";

/** Phase A: the changes of a break. Phase B adds versions, sign-off, reopen and rerun. */
export const WORKFLOW_ACTIONS = ["force_match", "unmatch", "write_off"] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];
export const WORKFLOW_ACTION_LABEL: Record<WorkflowAction, string> = { force_match: "Force match", unmatch: "Unmatch", write_off: "Write-off" };
export const WORKFLOW_ACTION_TEXT: Record<WorkflowAction, string> = {
  force_match: "Matching a break across a difference in totals",
  unmatch: "Undoing a break's match",
  write_off: "Closing a break as written off",
};

/** What a rule can test. `amount` is in minor units of the break's currency (no FX), positive. */
export const ATTRS = ["amount", "currency", "recon", "ageDays"] as const;
export type Attr = (typeof ATTRS)[number];
export const ATTR_LABEL: Record<Attr, string> = { amount: "Amount", currency: "Currency", recon: "Recon", ageDays: "Age in days" };
export const NUMERIC_ATTRS: readonly Attr[] = ["amount", "ageDays"];
export const NUMBER_OPS = ["gte", "gt", "lte", "lt", "eq"] as const;
export const SET_OPS = ["in", "not_in"] as const;
export type Op = (typeof NUMBER_OPS)[number] | (typeof SET_OPS)[number];
export const OP_LABEL: Record<Op, string> = { gte: "at least", gt: "more than", lte: "at most", lt: "less than", eq: "exactly", in: "is one of", not_in: "is not one of" };

export const RULES_MAX = 20;
export const CONDITIONS_MAX = 8;
export const LEVELS_MAX = 5;
export const GROUPS_MAX = 4;
export const PEOPLE_MAX = 20;
export const RULE_NAME_MAX = 80;
export const OVERRIDE_REASON_MAX = 500;

export type Condition = { attr: Attr; op: Op; value: string | string[] };
export type Need = { kind: "any" } | { kind: "all" } | { kind: "count"; n: number };
export type Group = { spaceRoles: SpaceRole[]; globalRoles: string[]; users: string[]; need: Need };
export type Level = { name: string; groups: Group[] };
export type Rule = { name: string; when: Condition[]; levels: Level[] };
export type WorkflowSpecShape = { rules: Rule[] };
/** The attributes of one request (amount as a decimal string of minor units: bigint-safe over JSON). */
export type Attributes = { amount?: string; currency?: string | null; recon?: string; ageDays?: number };

/** The chain a break change takes when its space has no published workflow, or no rule matches: today's rule (DEC-052). */
export const DEFAULT_LEVELS: Level[] = [{ name: "Checker", groups: [{ spaceRoles: ["reviewer", "space_admin"], globalRoles: [], users: [], need: { kind: "any" } }] }];
export const DEFAULT_RULE: Rule = { name: "Default", when: [], levels: DEFAULT_LEVELS };

const num = (v: string | number | undefined | null): bigint | null => {
  if (v === undefined || v === null || v === "") return null;
  try { return BigInt(typeof v === "number" ? Math.trunc(v) : v); } catch { return null; }
};
/** One condition against the attributes; an attribute the request doesn't have fails it. */
export function holds(c: Condition, a: Attributes): boolean {
  const raw = a[c.attr];
  if (raw === undefined || raw === null) return false;
  if (c.op === "in" || c.op === "not_in") {
    const set = Array.isArray(c.value) ? c.value : [c.value];
    const has = set.includes(String(raw));
    return c.op === "in" ? has : !has;
  }
  const x = num(raw as string | number), y = num(Array.isArray(c.value) ? c.value[0] : c.value);
  if (x === null || y === null) return false;
  return c.op === "gte" ? x >= y : c.op === "gt" ? x > y : c.op === "lte" ? x <= y : c.op === "lt" ? x < y : x === y;
}
/** The rule a request takes: the first whose conditions all hold, else the default (DEC-052 Q4 default). */
export function pickRule(spec: WorkflowSpecShape | null, a: Attributes): { rule: Rule; index: number | null } {
  const i = spec ? spec.rules.findIndex((r) => r.when.every((c) => holds(c, a))) : -1;
  return i >= 0 ? { rule: spec!.rules[i]!, index: i } : { rule: DEFAULT_RULE, index: null };
}

/**
 * How many approvals a group still needs, given the people who may approve it now (`eligible`, the requester and
 * people who decided another level already left out) and the approvals it has. `all` = every eligible person, at
 * least one; `count` never more than can be found (the editor warns, the request is blocked: `short`).
 */
export function groupNeeds(need: Need, eligible: number, approvals: number): { left: number; short: boolean } {
  const want = need.kind === "any" ? 1 : need.kind === "all" ? Math.max(1, eligible + approvals) : need.n;
  return { left: Math.max(0, want - approvals), short: eligible + approvals < want };
}
