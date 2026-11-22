// /v1/spaces/:spaceId/approvals. Any role of the space reads its inbox; deciding stays on each version's own route.
import { Elysia } from "elysia";
import { ApprovalListQuery } from "@starterkit/shared/contracts/approvals";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { guard } from "../auth";
import { approvalFacets, approvalPage } from "./service";

/** The route of a space's approvals inbox. */
export const approvalsController = () => new Elysia().use(guard)
  .get("/v1/spaces/:spaceId/approvals", ({ ctx, query }) => approvalPage(ctx, query), { query: ApprovalListQuery, guard: { space: SPACE_ROLES } })
  .get("/v1/spaces/:spaceId/approvals/facets", ({ ctx, query }) => approvalFacets(ctx, query), { query: ApprovalListQuery, guard: { space: SPACE_ROLES } });
