// /v1/spaces*. Query 400 → guard 401/403 (a SpaceGuard: 404 for a non-UUID :spaceId, then the roles in that space) →
// body 400 → 404 → rules → change → activity (the last four in service.ts).
import { Elysia } from "elysia";
import { CreateSpaceBody, SetSpaceMemberBody, SpaceCandidateListQuery, SpaceListQuery, SpaceMemberListQuery, UpdateSpaceBody } from "@starterkit/shared/contracts/spaces";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { candidatePage, createSpace, memberPage, removeMember, setMember, spaceDetail, spacePage, updateSpace } from "./service";

/** The routes of /v1/spaces*. */
export const spacesController = () =>
  new Elysia()
    .use(guard)
    /** The caller's spaces with their roles in each; every space with `space.view`. */
    .get("/v1/spaces", ({ ctx, query }) => spacePage(ctx, query), { query: SpaceListQuery, guard: null })
    .post("/v1/spaces", async (c) => {
      const s = await createSpace(c.ctx, await body(c, CreateSpaceBody));
      c.set.status = 201;
      return s;
    }, { guard: "space.manage" })
    /** The space with the caller's roles in it ([] when let in through `space.manage`). */
    .get("/v1/spaces/:spaceId", ({ ctx }) => spaceDetail(ctx.space!.id, ctx.space!.roles), { guard: { space: SPACE_ROLES, or: "space.manage" } })
    .patch("/v1/spaces/:spaceId", async (c) => updateSpace(c.ctx, c.ctx.space!.id, await body(c, UpdateSpaceBody)), { guard: { space: ["space_admin"], or: "space.manage" } })
    .get("/v1/spaces/:spaceId/members", ({ ctx, query }) => memberPage(ctx.space!.id, query), { query: SpaceMemberListQuery, guard: { space: SPACE_ROLES, or: "space.manage" } })
    /** The app's users, each marked when already a member: who the Members screen can add. */
    .get("/v1/spaces/:spaceId/candidates", ({ ctx, query }) => candidatePage(ctx.space!.id, query), { query: SpaceCandidateListQuery, guard: { space: ["space_admin"], or: "space.manage" } })
    .put("/v1/spaces/:spaceId/members/:userId", async (c) => {
      const b = await body(c, SetSpaceMemberBody);
      return setMember(c.ctx, c.ctx.space!.id, idParam(c.params.userId, "user"), b);
    }, { guard: { space: ["space_admin"], or: "space.manage" } })
    .delete("/v1/spaces/:spaceId/members/:userId", async ({ ctx, params }) => {
      await removeMember(ctx, ctx.space!.id, idParam(params.userId, "user"));
      return { ok: true };
    }, { guard: { space: ["space_admin"], or: "space.manage" } });
