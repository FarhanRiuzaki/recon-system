// /v1/spaces/:spaceId/inbox/*: a space's inbox folders and files (Inbox files). Query 400 → guard 401/403 (the space's
// roles, SPACE_ACTION.viewInbox / uploadInbox / manageInbox) → body 400 → 404 → rules → change → activity (service.ts).
import { Elysia } from "elysia";
import { CreateInboxFolderBody } from "@starterkit/shared/contracts/inbox";
import { SPACE_ACTION } from "@starterkit/shared/spaces";
import { body } from "../../kernel/parse";
import { guard } from "../auth";
import { createFolder, deleteFolder, folderList } from "./service";

export const inboxController = () =>
  new Elysia()
    .use(guard)
    /** The space's inbox root and its folders, each with its file count, newest file and status summary. */
    .get("/v1/spaces/:spaceId/inbox/folders", ({ ctx }) => folderList(ctx), { guard: { space: SPACE_ACTION.viewInbox } })
    .post("/v1/spaces/:spaceId/inbox/folders", async (c) => {
      const f = await createFolder(c.ctx, (await body(c, CreateInboxFolderBody)).name);
      c.set.status = 201;
      return f;
    }, { guard: { space: SPACE_ACTION.manageInbox } })
    .delete("/v1/spaces/:spaceId/inbox/folders/:folder", async ({ ctx, params, set }) => {
      await deleteFolder(ctx, params.folder);
      set.status = 204;
    }, { guard: { space: SPACE_ACTION.manageInbox } });
