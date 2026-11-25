// /v1/spaces/:spaceId/inbox/*: a space's inbox folders and files (Inbox files). Query 400 → guard 401/403 (the space's
// roles, SPACE_ACTION.viewInbox / uploadInbox / manageInbox) → body 400 → 404 → rules → change → activity (service.ts).
import { Elysia } from "elysia";
import { CreateInboxFolderBody, InboxFileListQuery, InboxFileNameQuery } from "@starterkit/shared/contracts/inbox";
import { SPACE_ACTION } from "@starterkit/shared/spaces";
import { body } from "../../kernel/parse";
import { guard } from "../auth";
import { createFolder, deleteFile, deleteFolder, downloadFile, filePage, folderList, uploadFile } from "./service";

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
    }, { guard: { space: SPACE_ACTION.manageInbox } })
    /** A folder's files (from disk), each with who uploaded it and what each reading source did with it. */
    .get("/v1/spaces/:spaceId/inbox/folders/:folder/files", ({ ctx, params, query }) => filePage(ctx, params.folder, query), { query: InboxFileListQuery, guard: { space: SPACE_ACTION.viewInbox } })
    /** One file's bytes, as an attachment. */
    .get("/v1/spaces/:spaceId/inbox/folders/:folder/files/download", ({ ctx, params, query }) => downloadFile(ctx, params.folder, query.name), { query: InboxFileNameQuery, guard: { space: SPACE_ACTION.viewInbox } })
    /** An upload: the raw bytes streamed (Content-Length, x-file-name URL-encoded), up to INBOX_UPLOAD_MAX_MB. */
    .post("/v1/spaces/:spaceId/inbox/folders/:folder/files", async (c) => {
      const h = c.request.headers;
      const up = await uploadFile(c.ctx, c.params.folder, h.get("x-file-name"), h.get("content-length"), c.request.body);
      c.set.status = 201;
      return up;
    }, { guard: { space: SPACE_ACTION.uploadInbox } })
    /** A file no source has read yet. */
    .delete("/v1/spaces/:spaceId/inbox/folders/:folder/files", async ({ ctx, params, query, set }) => {
      await deleteFile(ctx, params.folder, query.name);
      set.status = 204;
    }, { query: InboxFileNameQuery, guard: { space: SPACE_ACTION.manageInbox } });
