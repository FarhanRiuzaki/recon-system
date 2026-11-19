import { z } from "zod";
import { SPACE_CANDIDATE_SORTS, SPACE_MEMBER_SORTS, SPACE_SORTS, USER_SPACE_SORTS } from "../paging";
import { SPACE_CODE, SPACE_NAME_MAX, SPACE_ROLES, SPACE_STATUSES } from "../spaces";
import { ListQuery, sortParam } from "./common";

export { type SpaceRole, type SpaceStatus } from "../spaces";

export const SpaceDto = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.enum(SPACE_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpaceDto = z.infer<typeof SpaceDto>;

/** A row of GET /api/spaces: the space plus the caller's own roles in it ([] = listed through `space.view` only). */
export const SpaceRowDto = SpaceDto.extend({ roles: z.array(z.enum(SPACE_ROLES)) });
export type SpaceRowDto = z.infer<typeof SpaceRowDto>;

export { SPACE_CANDIDATE_SORTS, SPACE_MEMBER_SORTS, SPACE_SORTS, USER_SPACE_SORTS };

/** GET /api/spaces: `q` matches the code or the name. */
export const SpaceListQuery = ListQuery.extend({ sort: sortParam(SPACE_SORTS) });
export type SpaceListQuery = z.infer<typeof SpaceListQuery>;

const name = z.string().trim().min(1).max(SPACE_NAME_MAX);

export const CreateSpaceBody = z.strictObject({ code: z.string().trim().toLowerCase().regex(SPACE_CODE), name });
export type CreateSpaceBody = z.infer<typeof CreateSpaceBody>;

/** Only the fields sent change; nothing to change → 200 with the space, no activity entry. */
export const UpdateSpaceBody = z.strictObject({ name: name.optional(), status: z.enum(SPACE_STATUSES).optional() });
export type UpdateSpaceBody = z.infer<typeof UpdateSpaceBody>;

/**
 * One member of a space with every role they hold in it (SPACE_ROLES order), whether their account is active, and
 * their last full sign-in (ISO, the user's `last_login_at`; null when they never signed in).
 */
export const SpaceMemberDto = z.object({
  userId: z.string(), name: z.string(), username: z.string(), roles: z.array(z.enum(SPACE_ROLES)), active: z.boolean(), lastSignInAt: z.string().nullable(),
});
export type SpaceMemberDto = z.infer<typeof SpaceMemberDto>;

/** GET /api/spaces/{spaceId}/members: `q` matches the name or the username. */
export const SpaceMemberListQuery = ListQuery.extend({ sort: sortParam(SPACE_MEMBER_SORTS) });
export type SpaceMemberListQuery = z.infer<typeof SpaceMemberListQuery>;

/** A user of the app the Members screen can add: `member` = already a member of this space. */
export const SpaceCandidateDto = z.object({ userId: z.string(), name: z.string(), username: z.string(), active: z.boolean(), member: z.boolean() });
export type SpaceCandidateDto = z.infer<typeof SpaceCandidateDto>;

/** GET /api/spaces/{spaceId}/candidates: `q` matches the name or the username. */
export const SpaceCandidateListQuery = ListQuery.extend({ sort: sortParam(SPACE_CANDIDATE_SORTS) });
export type SpaceCandidateListQuery = z.infer<typeof SpaceCandidateListQuery>;

/** A space a user is a member of, with every role they hold there (SPACE_ROLES order): a row of GET /api/users/{id}/spaces. */
export const UserSpaceDto = z.object({ spaceId: z.string(), code: z.string(), name: z.string(), status: z.enum(SPACE_STATUSES), roles: z.array(z.enum(SPACE_ROLES)) });
export type UserSpaceDto = z.infer<typeof UserSpaceDto>;

/** GET /api/users/{id}/spaces: name A–Z unless `sort` says otherwise. */
export const UserSpaceListQuery = ListQuery.extend({ sort: sortParam(USER_SPACE_SORTS) });
export type UserSpaceListQuery = z.infer<typeof UserSpaceListQuery>;

/** PUT /api/spaces/{spaceId}/members/{userId}: the user's whole role set in the space (1–7 roles, no repeats). */
export const SetSpaceMemberBody = z.strictObject({
  roles: z.array(z.enum(SPACE_ROLES)).min(1).max(SPACE_ROLES.length).refine((r) => new Set(r).size === r.length, "a role is repeated"),
});
export type SetSpaceMemberBody = z.infer<typeof SetSpaceMemberBody>;
