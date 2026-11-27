// /v1/imports*. Query 400 → guard 401/403 → body 400 → 404 → rules → change → activity (the last ones in service.ts).
import { Elysia } from "elysia";
import { ImportCheckListQuery, ImportFeedBody, ImportFeedListQuery, ImportFeedPatchBody, ImportHistoryListQuery, ImportMonitorQuery, ImportRunListQuery } from "@starterkit/shared/contracts/imports";
import { notFound } from "../../kernel/errors";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { checkPage, feedDate, historyPage, issues, monitor, runPage } from "./monitor";
import { createFeed, deleteFeed, feedById, feedPage, updateFeed } from "./service";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A path date (YYYY-MM-DD, a real day), else 404 like a path id that is not a UUID. */
function dateParam(d: string): string {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!ISO_DATE.test(d) || Number.isNaN(t) || !new Date(t).toISOString().startsWith(d)) throw notFound("date");
  return d;
}

/** The routes of /v1/imports* (global: import.view reads, import.manage changes). */
export const importsController = () =>
  new Elysia()
    .use(guard)
    /** Monitoring: every feed's scheduler and its last MONITOR_DAYS MIS dates (409 when staging isn't set up). */
    .get("/v1/imports/monitor", ({ query }) => monitor(query), { query: ImportMonitorQuery, guard: "import.view" })
    /** The Monitoring badge: how many issues are open. */
    .get("/v1/imports/issues", () => issues(), { guard: "import.view" })
    /** One page of feeds, name A–Z unless `sort` says otherwise; `q` matches the name. */
    .get("/v1/imports/feeds", ({ query }) => feedPage(query), { query: ImportFeedListQuery, guard: "import.view" })
    .post("/v1/imports/feeds", async (c) => {
      const f = await createFeed(c.ctx, await body(c, ImportFeedBody));
      c.set.status = 201;
      return f;
    }, { guard: "import.manage" })
    .get("/v1/imports/feeds/:id", async ({ params }) => {
      const f = await feedById(idParam(params.id, "import feed"));
      if (!f) throw notFound("import feed");
      return f;
    }, { guard: "import.view" })
    .get("/v1/imports/feeds/:id/dates/:date", ({ params }) => feedDate(idParam(params.id, "import feed"), dateParam(params.date)), { guard: "import.view" })
    .get("/v1/imports/feeds/:id/history", ({ params, query }) => historyPage(idParam(params.id, "import feed"), query), { query: ImportHistoryListQuery, guard: "import.view" })
    .get("/v1/imports/feeds/:id/runs", ({ params, query }) => runPage(idParam(params.id, "import feed"), query), { query: ImportRunListQuery, guard: "import.view" })
    .get("/v1/imports/feeds/:id/checks", ({ params, query }) => checkPage(idParam(params.id, "import feed"), query), { query: ImportCheckListQuery, guard: "import.view" })
    .patch("/v1/imports/feeds/:id", async (c) => {
      const b = await body(c, ImportFeedPatchBody);
      return updateFeed(c.ctx, idParam(c.params.id, "import feed"), b);
    }, { guard: "import.manage" })
    .delete("/v1/imports/feeds/:id", async ({ ctx, params }) => {
      await deleteFeed(ctx, idParam(params.id, "import feed"));
      return { ok: true };
    }, { guard: "import.manage" });
