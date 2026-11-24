// /v1/dashboard and /v1/dashboard/recon. The admin numbers need user.view or audit.view (either one: the guard takes
// one permission, so the handler checks, allowlisted in conformance.test.ts); the recon numbers any signed-in user, over
// only the spaces the caller holds a role in (engine dashboard.ts).
import { Elysia } from "elysia";
import { ApiError } from "../../kernel/errors";
import { guard } from "../auth";
import { dashboard } from "./service";
import { DashboardQuery, ReconDashboardQuery } from "@starterkit/shared/contracts/dashboard";
import { reconDashboard } from "../engine";

/** The route of /v1/dashboard. */
export const dashboardController = () => new Elysia().use(guard)
  .get("/v1/dashboard", ({ ctx, query }) => {
    if (!ctx.perms.has("user.view") && !ctx.perms.has("audit.view")) throw new ApiError("forbidden");
    return dashboard(ctx, query);
  }, { query: DashboardQuery, guard: null })
  /** The recon performance of a period over the caller's spaces (one, or one recon). */
  .get("/v1/dashboard/recon", ({ ctx, query }) => reconDashboard(ctx, query), { query: ReconDashboardQuery, guard: null });
