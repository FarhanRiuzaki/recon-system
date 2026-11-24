// /v1/dashboard and /v1/dashboard/recon. Any signed-in user (`guard: null`); the recon numbers cover only the spaces
// the caller holds a role in (engine dashboard.ts).
import { Elysia } from "elysia";
import { guard } from "../auth";
import { dashboard } from "./service";
import { DashboardQuery, ReconDashboardQuery } from "@starterkit/shared/contracts/dashboard";
import { reconDashboard } from "../engine";

/** The route of /v1/dashboard. */
export const dashboardController = () => new Elysia().use(guard)
  .get("/v1/dashboard", ({ ctx, query }) => dashboard(ctx, query), { query: DashboardQuery, guard: null })
  /** The recon performance of a period over the caller's spaces (one, or one recon). */
  .get("/v1/dashboard/recon", ({ ctx, query }) => reconDashboard(ctx, query), { query: ReconDashboardQuery, guard: null });
