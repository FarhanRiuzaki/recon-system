// Approval workflows (DEC-052; docs/superpowers/specs/2026-11-22-workflow-library-and-bindings-design.md), zod-free:
// the triggers approval rules bind, the attributes their conditions read, the limits, and the pure evaluation the API
// and the editors' "Who approves" share. A workflow (global library) = named chain of levels; a level passes when every
// group in it has its approvals (any / all / N of its eligible people). A space's approval rules for a trigger = ordered
// rules, the first whose conditions all hold picks the workflow; none holds = `otherwise` (null = the default chain).
import type { SpaceRole } from "./spaces";

/** What approval rules bind: phase A the changes of a break; phase B adds versions, sign-off, reopen and rerun. */
export const TRIGGERS = ["force_match", "unmatch", "write_off"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const TRIGGER_LABEL: Record<Trigger, string> = { force_match: "Force match", unmatch: "Unmatch", write_off: "Write-off" };
/** The module whose change a trigger is, for grouping on the approval rules page. */
export const TRIGGER_MODULE: Record<Trigger, "Breaks"> = { force_match: "Breaks", unmatch: "Breaks", write_off: "Breaks" };
export const TRIGGER_TEXT: Record<Trigger, string> = {
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
/** A library workflow's content. */
export type Chain = { name: string; levels: Level[] };
/** One approval rule: when its conditions all hold, the request takes `workflowId`'s live version. */
export type BindingRule = { name: string; when: Condition[]; workflowId: string };
export type BindingSpecShape = { rules: BindingRule[]; otherwise: string | null };
/** The attributes of one request (amount as a decimal string of minor units: bigint-safe over JSON). */
export type Attributes = { amount?: string; currency?: string | null; recon?: string; ageDays?: number };

/** The chain a request takes when its space has no published approval rules, or they end in the default: today's rule. */
export const DEFAULT_LEVELS: Level[] = [{ name: "Checker", groups: [{ spaceRoles: ["reviewer", "space_admin"], globalRoles: [], users: [], need: { kind: "any" } }] }];
export const DEFAULT_CHAIN: Chain = { name: "Default", levels: DEFAULT_LEVELS };

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
/**
 * The workflow approval rules give a request: the first rule whose conditions all hold, else `otherwise`; no rules at
 * all = the default chain (workflowId null).
 */
export function pickBinding(spec: BindingSpecShape | null, a: Attributes): { index: number | null; ruleName: string; workflowId: string | null } {
  if (!spec) return { index: null, ruleName: "Default", workflowId: null };
  const i = spec.rules.findIndex((r) => r.when.every((c) => holds(c, a)));
  return i >= 0 ? { index: i, ruleName: spec.rules[i]!.name, workflowId: spec.rules[i]!.workflowId } : { index: null, ruleName: "Otherwise", workflowId: spec.otherwise };
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
