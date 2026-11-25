// Report templates (the report generator, DEC-060): any role of the space reads; a config maker creates templates,
// edits, sends and discards drafts and retires a template; a config checker approves or sends back an official
// version someone else made (DEC-051).
import { Elysia } from "elysia";
import { ListQuery } from "@starterkit/shared/contracts/common";
import { CreateReportTemplateBody, ReportDecisionBody, ReportTemplateListQuery, SaveReportVersionBody } from "@starterkit/shared/contracts/reports";
import { SPACE_ACTION } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import {
  approveReportVersion, createTemplate, discardDraft, listTemplates, listVersions, newDraft, rejectReportVersion, retireTemplate, saveDraft, submitVersion, templateDetail,
} from "./service";


export const reportsController = () =>
  new Elysia()
    .use(guard)
    .get("/v1/spaces/:spaceId/reports/templates", ({ ctx, query }) => listTemplates(ctx, query), { query: ReportTemplateListQuery, guard: { space: SPACE_ACTION.viewReports } })
    .post("/v1/spaces/:spaceId/reports/templates", async (c) => {
      const t = await createTemplate(c.ctx, await body(c, CreateReportTemplateBody));
      c.set.status = 201;
      return t;
    }, { guard: { space: SPACE_ACTION.editReports } })
    .get("/v1/spaces/:spaceId/reports/templates/:templateId", ({ ctx, params }) => templateDetail(ctx, idParam(params.templateId, "report template")), { guard: { space: SPACE_ACTION.viewReports } })
    .get("/v1/spaces/:spaceId/reports/templates/:templateId/versions", ({ ctx, params, query }) => listVersions(ctx, idParam(params.templateId, "report template"), query), { query: ListQuery, guard: { space: SPACE_ACTION.viewReports } })
    .post("/v1/spaces/:spaceId/reports/templates/:templateId/versions", async (c) => {
      const v = await newDraft(c.ctx, idParam(c.params.templateId, "report template"));
      c.set.status = 201;
      return v;
    }, { guard: { space: SPACE_ACTION.editReports } })
    .patch("/v1/spaces/:spaceId/reports/templates/:templateId/versions/:versionId", async (c) => {
      const b = await body(c, SaveReportVersionBody);
      return saveDraft(c.ctx, idParam(c.params.templateId, "report template"), idParam(c.params.versionId, "report version"), b);
    }, { guard: { space: SPACE_ACTION.editReports } })
    .delete("/v1/spaces/:spaceId/reports/templates/:templateId/versions/:versionId", ({ ctx, params }) =>
      discardDraft(ctx, idParam(params.templateId, "report template"), idParam(params.versionId, "report version")), { guard: { space: SPACE_ACTION.editReports } })
    .post("/v1/spaces/:spaceId/reports/templates/:templateId/versions/:versionId/submit", ({ ctx, params }) =>
      submitVersion(ctx, idParam(params.templateId, "report template"), idParam(params.versionId, "report version")), { guard: { space: SPACE_ACTION.editReports } })
    .post("/v1/spaces/:spaceId/reports/templates/:templateId/versions/:versionId/approve", async (c) => {
      const b = await body(c, ReportDecisionBody);
      return approveReportVersion(c.ctx, idParam(c.params.templateId, "report template"), idParam(c.params.versionId, "report version"), b);
    }, { guard: { space: SPACE_ACTION.approveVersion } })
    .post("/v1/spaces/:spaceId/reports/templates/:templateId/versions/:versionId/reject", async (c) => {
      const b = await body(c, ReportDecisionBody);
      return rejectReportVersion(c.ctx, idParam(c.params.templateId, "report template"), idParam(c.params.versionId, "report version"), b);
    }, { guard: { space: SPACE_ACTION.approveVersion } })
    .post("/v1/spaces/:spaceId/reports/templates/:templateId/retire", ({ ctx, params }) => retireTemplate(ctx, idParam(params.templateId, "report template")), { guard: { space: SPACE_ACTION.editReports } });
