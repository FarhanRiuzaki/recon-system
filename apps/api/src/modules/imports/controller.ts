// /v1/imports*. Query 400 → guard 401/403 → body 400 → 404 → rules → change → activity (the last ones in service.ts).
import { Elysia } from "elysia";
import { ImportFeedBody, ImportFeedListQuery, ImportFeedPatchBody } from "@starterkit/shared/contracts/imports";
import { notFound } from "../../kernel/errors";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { createFeed, deleteFeed, feedById, feedPage, updateFeed } from "./service";

/** The routes of /v1/imports* (global: import.view reads, import.manage changes). */
export const importsController = () =>
  new Elysia()
    .use(guard)
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
    .patch("/v1/imports/feeds/:id", async (c) => {
      const b = await body(c, ImportFeedPatchBody);
      return updateFeed(c.ctx, idParam(c.params.id, "import feed"), b);
    }, { guard: "import.manage" })
    .delete("/v1/imports/feeds/:id", async ({ ctx, params }) => {
      await deleteFeed(ctx, idParam(params.id, "import feed"));
      return { ok: true };
    }, { guard: "import.manage" });
