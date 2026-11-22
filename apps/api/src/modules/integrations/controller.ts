// /v1/integrations/connectors (DEC-053): integration.view reads; integration.manage edits, publishes another's
// version and replaces credentials.
import { Elysia } from "elysia";
import { ConnectorListQuery, CreateConnectorBody, DisableConnectorBody, ReplaceSecretsBody, SaveConnectorBody, TokenCheckBody, TryBody } from "@starterkit/shared/contracts/integrations";
import { ReviewWorkflowBody } from "@starterkit/shared/contracts/workflows";
import { ActionRunListQuery } from "@starterkit/shared/contracts/breaks";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { csvFileName } from "@starterkit/ui/lib/csv";
import { actionRunCsv, actionRunPage } from "./actions";

/** A CSV attachment `<prefix>-<date in the app time zone>.csv`, never cached. */
const csvResponse = (prefix: string, text: string): Response =>
  new Response(text, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${csvFileName(prefix, Date.now())}"`, "Cache-Control": "no-store" } });
import type { ZodType } from "zod";
import { $ZodError } from "zod/v4/core";
import { ApiError } from "../../kernel/errors";
import { body as parseBody, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import {
  connectorDetail, connectorOperations, connectorPage, createConnector, disableConnector, discardDraft, enableConnector, replaceSecrets, reviewDraft, saveDraft, startDraft, submitDraft, tokenCheck,
  tryOperation,
} from "./service";

/** A body the contract refused: 400 with the first reason written for a person ("Use an https:// address."). */
const body = <T>(c: { request: Request }, schema: ZodType<T>): Promise<T> => parseBody(c, schema).catch((e: unknown) => {
  const i = e instanceof $ZodError ? e.issues.find((x) => x.code === "custom") : undefined;
  throw i ? new ApiError("bad_request", i.message) : e;
});
export const integrationsController = () => new Elysia().use(guard)
  // the space's approval action runs (stage 4): any role of the space reads them
  // what a recon's action may pick: the connectors' published versions and operations (no settings, no secrets)
  .get("/v1/spaces/:spaceId/connector-operations", () => connectorOperations(), { guard: { space: SPACE_ROLES } })
  .get("/v1/spaces/:spaceId/action-runs", async ({ ctx, query }) => (query.format === "csv" ? csvResponse("posting", await actionRunCsv(ctx, query)) : actionRunPage(ctx, query)), { query: ActionRunListQuery, guard: { space: SPACE_ROLES } })
  .get("/v1/integrations/connectors", ({ query }) => connectorPage(query), { query: ConnectorListQuery, guard: "integration.view" })
  .post("/v1/integrations/connectors", async (c) => {
    const b = await body(c, CreateConnectorBody);
    return createConnector(c.ctx, b);
  }, { guard: "integration.manage" })
  .get("/v1/integrations/connectors/:id", ({ ctx, params }) => connectorDetail(ctx, idParam(params.id, "connector")), { guard: "integration.view" })
  .post("/v1/integrations/connectors/:id/draft", ({ ctx, params }) => startDraft(ctx, idParam(params.id, "connector")), { guard: "integration.manage" })
  .patch("/v1/integrations/connectors/:id/draft", async (c) => {
    const b = await body(c, SaveConnectorBody);
    return saveDraft(c.ctx, idParam(c.params.id, "connector"), b);
  }, { guard: "integration.manage" })
  .post("/v1/integrations/connectors/:id/draft/submit", ({ ctx, params }) => submitDraft(ctx, idParam(params.id, "connector")), { guard: "integration.manage" })
  .post("/v1/integrations/connectors/:id/draft/discard", ({ ctx, params }) => discardDraft(ctx, idParam(params.id, "connector")), { guard: "integration.manage" })
  .post("/v1/integrations/connectors/:id/review/approve", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewDraft(c.ctx, idParam(c.params.id, "connector"), b, "approve");
  }, { guard: "integration.manage" })
  .post("/v1/integrations/connectors/:id/review/reject", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewDraft(c.ctx, idParam(c.params.id, "connector"), b, "reject");
  }, { guard: "integration.manage" })
  .put("/v1/integrations/connectors/:id/secrets", async (c) => {
    const b = await body(c, ReplaceSecretsBody);
    return replaceSecrets(c.ctx, idParam(c.params.id, "connector"), b);
  }, { guard: "integration.manage" })
  .post("/v1/integrations/connectors/:id/disable", async (c) => {
    const b = await body(c, DisableConnectorBody);
    return disableConnector(c.ctx, idParam(c.params.id, "connector"), b);
  }, { guard: "integration.manage" })
  .post("/v1/integrations/connectors/:id/enable", ({ ctx, params }) => enableConnector(ctx, idParam(params.id, "connector")), { guard: "integration.manage" })
  // a new token from the bank: tells whether the environment's credentials work (writes only the token cache)
  .post("/v1/integrations/connectors/:id/token-check", async (c) => {
    const b = await body(c, TokenCheckBody);
    return tokenCheck(c.ctx, idParam(c.params.id, "connector"), b);
  }, { guard: "integration.manage" })
  .post("/v1/integrations/connectors/:id/try", async (c) => {
    const b = await body(c, TryBody);
    return tryOperation(c.ctx, idParam(c.params.id, "connector"), b);
  }, { guard: "integration.manage" });
