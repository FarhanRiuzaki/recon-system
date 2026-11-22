// What a library workflow and a space's approval rules share (DEC-052): versions draft → in_review → published, the
// names of who made, sent and decided one, and who may decide the version in review (the workflow of workflows is
// fixed here, never routed through a workflow, so nobody locks anyone out).
import { isSuperadmin } from "@starterkit/shared/permissions";
import { inArray } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import type { Ctx } from "../auth";
import { users } from "../users";

export type VersionRow = {
  id: string; version: number; status: string; spec: unknown; makerId: string | null; submittedBy: string | null; submittedAt: Date | null;
  decidedBy: string | null; decidedAt: Date | null; reviewComment: string | null; overrideReason: string | null; updatedAt: Date;
};

/** Display names of users by id. */
export async function userNames(tx: InTx, ids: readonly (string | null)[]): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  return new Map(uniq.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq))).map((u) => [u.id, u.name]) : []);
}
export const versionPeople = (r: VersionRow | null) => (r ? [r.makerId, r.submittedBy, r.decidedBy] : []);

export function versionDto<S>(r: VersionRow, n: ReadonlyMap<string, string | null>) {
  const p = (id: string | null) => (id ? { id, name: n.get(id) ?? null } : null);
  return {
    id: r.id, version: r.version, status: r.status as "draft" | "in_review" | "published" | "retired", spec: r.spec as S,
    maker: p(r.makerId), submittedBy: p(r.submittedBy), submittedAt: r.submittedAt?.toISOString() ?? null, decidedBy: p(r.decidedBy), decidedAt: r.decidedAt?.toISOString() ?? null,
    reviewComment: r.reviewComment, overrideReason: r.overrideReason, updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Why the caller can't publish or send back the version in review, or null; `overrideOnly`: a Superadmin's own version,
 * only by override with a reason. `editors` names who decides ("a workflow manager").
 */
export function reviewRule(ctx: Ctx, open: VersionRow | null, canEdit: boolean, editors: string): { blocked: string | null; overrideOnly: boolean } {
  if (!open || open.status !== "in_review") return { blocked: "No version waits for approval.", overrideOnly: false };
  if (!canEdit) return { blocked: `Only ${editors} decides these changes.`, overrideOnly: false };
  const own = open.makerId === ctx.user.id || open.submittedBy === ctx.user.id;
  if (own && isSuperadmin(ctx.user.roles)) return { blocked: null, overrideOnly: true };
  if (own) return { blocked: `You made this version. Another ${editors.replace(/^an? /, "")} decides it.`, overrideOnly: false };
  return { blocked: null, overrideOnly: false };
}
