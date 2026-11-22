// API contract for the backend: one JSON Schema (draft 2020-12) per zod contract in packages/shared/src/contracts/*, written
// to docs/api/schemas/<Name>.json with zod's own z.toJSONSchema. Request schemas (names ending in Body or Query) are
// emitted as the client sends them (fields with a default are optional); every other schema as the server answers.
// Page answers and the two answer shapes no screen parses are composed below from the contracts.
// It also rewrites the activity action table in docs/api/README.md (between the actions:start/end markers) from the
// action vocabulary (ACTION_LABEL) and the before/after shapes below.
// Usage: bun run api:schemas (rewrites the folder and the table). src/test/api-contract.test.ts fails when either drifts.
// Limits: refinements across fields (date range, CreateUserBody password/invite, UpdateRoleBody add/remove) and the
// permission catalog check are code, not JSON Schema; docs/api/README.md states them.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ACTION_LABEL } from "@starterkit/shared/audit";
import * as audit from "@starterkit/shared/contracts/audit";
import * as auth from "@starterkit/shared/contracts/auth";
import * as common from "@starterkit/shared/contracts/common";
import * as dashboard from "@starterkit/shared/contracts/dashboard";
import * as me from "@starterkit/shared/contracts/me";
import * as projects from "@starterkit/shared/contracts/projects";
import * as rbac from "@starterkit/shared/contracts/rbac";
import * as approvals from "@starterkit/shared/contracts/approvals";
import * as breaks from "@starterkit/shared/contracts/breaks";
import * as workflows from "@starterkit/shared/contracts/workflows";
import * as recon from "@starterkit/shared/contracts/recon";
import * as sources from "@starterkit/shared/contracts/sources";
import * as spaces from "@starterkit/shared/contracts/spaces";
import * as users from "@starterkit/shared/contracts/users";

export const SCHEMA_DIR = path.resolve(import.meta.dirname, "../../../docs/api/schemas");

/** `Page<T>` (contracts/common.ts) for one item schema. */
const pageOf = (item: z.ZodType) => z.object({
  items: z.array(item),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int(),
  totalCapped: z.boolean().optional(),
});

const COMPOSED = {
  UserPage: pageOf(users.UserRowDto),
  RoleOptionPage: pageOf(rbac.RoleOption),
  SessionPage: pageOf(me.SessionDto),
  SavedViewPage: pageOf(me.SavedViewDto),
  RolePage: pageOf(rbac.RoleDto),
  PermissionPage: pageOf(rbac.PermissionDto),
  ActivityPage: pageOf(audit.ActivityDto),
  AuthLogPage: pageOf(audit.AuthLogDto),
  ProjectPage: pageOf(projects.ProjectDto),
  LibraryPage: pageOf(workflows.LibraryRowDto),
  UsedByPage: pageOf(workflows.UsedByRowDto),
  SpacePage: pageOf(spaces.SpaceRowDto),
  SpaceMemberPage: pageOf(spaces.SpaceMemberDto),
  SpaceCandidatePage: pageOf(spaces.SpaceCandidateDto),
  UserSpacePage: pageOf(spaces.UserSpaceDto),
  SourcePage: pageOf(sources.SourceRowDto),
  SourceFilePage: pageOf(sources.SourceFileDto),
  SourceSnapshotPage: pageOf(sources.SourceSnapshotDto),
  QuarantinePage: pageOf(sources.QuarantineRowDto),
  SourceRecordPage: pageOf(sources.SourceRecordDto),
  SourcePullPage: pageOf(sources.SourcePullDto),
  SourceVersionPage: pageOf(sources.SourceVersionRowDto),
  ApprovalPage: pageOf(approvals.ApprovalRowDto),
  BreakPage: pageOf(breaks.BreakRowDto),
  BreakItemPage: pageOf(breaks.BreakItemDto),
  SignoffPage: pageOf(recon.SignoffRowDto),
  ReconPage: pageOf(recon.ReconRowDto),
  ReconVersionPage: pageOf(recon.ReconVersionRowDto),
  ReconRunPage: pageOf(recon.ReconRunDto),
  ReconRunItemPage: pageOf(recon.ReconRunItemDto),
  ReconSimChangePage: pageOf(recon.ReconSimChangeDto),
  OkDto: z.object({ ok: z.literal(true) }),
  TemporaryPasswordDto: z.object({ temporaryPassword: z.string() }),
};

/** File name → file text, for every zod schema the contract modules export plus the composed ones. */
export function apiSchemas(): Record<string, string> {
  const named = [approvals, audit, auth, breaks, workflows, common, dashboard, me, projects, rbac, recon, sources, spaces, users, COMPOSED].flatMap((m) => Object.entries(m));
  const out: Record<string, string> = {};
  for (const [name, schema] of named) {
    if (!(schema instanceof z.ZodType)) continue;
    const file = `${name}.json`;
    if (file in out) throw new Error(`two contracts are named ${name}`);
    const { $schema, ...json } = z.toJSONSchema(schema, { io: /(Body|Query)$/.test(name) || name === "BulkUserFilter" ? "input" : "output" });
    out[file] = `${JSON.stringify({ $schema, title: name, ...json }, null, 2)}\n`;
  }
  return out;
}

/** Target type and before / after of each activity action, as the routes record them ("–" = null). */
export const ACTION_SHAPES: Record<string, [target: string, before: string, after: string]> = {
  "user.create": ["user", "–", "the new user ([UserDto](schemas/UserDto.json)) + `invited: boolean`"],
  "user.update": ["user", "changed fields only, of `name`, `username`, `email`, `roles`", "the same fields, new values"],
  "user.activate": ["user", "`{ isActive: false }`", "`{ isActive: true }`"],
  "user.deactivate": ["user", "`{ isActive: true }`", "`{ isActive: false }`"],
  "user.delete": ["user", "the user ([UserDto](schemas/UserDto.json))", "–"],
  "user.assign_role": ["user", "`{ roles }`", "`{ roles }` (bulk assign)"],
  "user.reset_password": ["user", "–", "– (the temporary password is never recorded)"],
  "user.session_end": ["user", "–", "`{ session: device }`"],
  "role.create": ["role", "–", "`{ name, added: permissions, removed: [] }`"],
  "role.update": ["role", "`{ name }` (before)", "`{ name, added, removed }` (effective change only)"],
  "role.delete": ["role", "`{ name, permissions }`", "–"],
  "permission.create": ["permission (id and label: the new names, comma-joined)", "–", "`{ created: names }`"],
  "me.update": ["user (self)", "`{ name, email }`", "`{ name, email }`"],
  "me.password": ["user (self)", "–", "–"],
  "me.connect": ["user (self)", "–", "`{ provider }`"],
  "me.disconnect": ["user (self)", "`{ provider }`", "–"],
  "me.session_end": ["session (label: device)", "–", "–"],
  "me.2fa_setup": ["user (self)", "–", "– (the secret is never recorded)"],
  "me.2fa_enable": ["user (self)", "–", "– (recovery codes are never recorded)"],
  "me.2fa_disable": ["user (self)", "–", "–"],
  "project.create": ["project", "–", "the new project ([ProjectDto](schemas/ProjectDto.json))"],
  "project.update": ["project", "changed fields only, of `name`, `description`, `status`", "the same fields, new values"],
  "project.delete": ["project", "the project ([ProjectDto](schemas/ProjectDto.json))", "–"],
  "space.create": ["space", "–", "the new space ([SpaceDto](schemas/SpaceDto.json))"],
  "space.update": ["space", "changed fields only, of `name`, `status`", "the same fields, new values"],
  "space.member_set": ["space", "`{ user: { id, name }, roles }` (`[]` for a new member)", "`{ user: { id, name }, roles }`"],
  "space.member_remove": ["space", "`{ user: { id, name }, roles }`", "–"],
  "source.create": ["source", "–", "`{ code, name, kind }`"],
  "source.connection_set": ["source", "`{ engine, options }` (null for the first)", "`{ engine, options }` (never the credential)"],
  "source.version_create": ["source", "–", "`{ version, from }` (`from` = the published version copied, or null)"],
  "source.version_update": ["source", "`{ version, specHash }`", "`{ version, specHash }`"],
  "source.version_submit": ["source", "–", "`{ version, specHash }`"],
  "source.version_approve": ["source", "–", "`{ version, specHash, retired, amountUnit? }` (`retired` = the version it replaced, or null; `amountUnit` = `{ before, after }` (`major`/`minor`) when the amount's unit changed)"],
  "source.version_reject": ["source", "–", "`{ version, comment }`"],
  "source.share": ["source", "–", "`{ space: { id, code, name } }`"],
  "source.unshare": ["source", "`{ space: { id, code, name } }`", "–"],
  "source.discard": ["source", "`{ code, name, kind }`", "–"],
  "source.run": ["source", "–", "`{ businessDate }` (the snapshot date pulled again, or null for a pull or scan)"],
  "recon.create": ["recon", "–", "`{ code, name, version, specHash }` (the recon and its draft version 1)"],
  "recon.version_create": ["recon", "–", "`{ version, from }` (`from` = the published version copied)"],
  "recon.version_update": ["recon", "`{ version, specHash }`", "`{ version, specHash }`"],
  "recon.version_submit": ["recon", "–", "`{ version, specHash }`"],
  "recon.version_approve": ["recon", "–", "`{ version, specHash, retired }` (`retired` = the version it replaced, or null)"],
  "recon.version_reject": ["recon", "–", "`{ version, comment }`"],
  "recon.discard": ["recon", "`{ code, name }`", "–"],
  "recon.version_discard": ["recon", "`{ version }`", "–"],
  "break.assign": ["break (the item; label its reference)", "`{ assignee, state }`", "`{ assignee, state }` (assignee null = back to Unassigned)"],
  "break.take": ["break", "`{ assignee, state }`", "`{ assignee, state }` (the caller)"],
  "break.state": ["break", "`{ state }`", "`{ state }` (investigating or pending_external)"],
  "break.match": ["break", "`{ state }`", "`{ resolution, items (side, ref), proposedBy?, note? }`"],
  "break.close": ["break", "`{ state }`", "`{ resolution, note }` (DUPLICATE or NO_ACTION)"],
  "break.request": ["break", "`{ state }`", "`{ kind, note, items? }` (force_match, unmatch or write_off; items = the other items of a force match)"],
  "break.approve": ["break", "`{ level }`", "`{ kind, level, of, note? }`; the last level adds `final` and what the change did (`resolution`, `items` or `unmatched`)"],
  "break.reject": ["break", "`{ level }`", "`{ kind, note, requestedBy }`"],
  "break.override": ["break", "`{ level }`", "`{ kind, reason }` and what the change did (`resolution`, `items` or `unmatched`)"],
  "break.cancel": ["break", "`{ level }`", "`{ kind }`"],
  "workflow.create": ["workflow", "—", "`{ name, levels }`"],
  "workflow.save": ["workflow", "—", "`{ version, from? }` (a new draft) or `{ version, levels }`"],
  "workflow.submit": ["workflow", "—", "`{ version }`"],
  "workflow.publish": ["workflow", "—", "`{ version, comment?, override? }`"],
  "workflow.reject": ["workflow", "—", "`{ version, comment }`"],
  "workflow.discard": ["workflow", "`{ version }`", "—"],
  "workflow.archive": ["workflow", "`{ archived: false }`", "`{ archived: true }`"],
  "rules.save": ["approval_rules", "—", "`{ version, from? }` (a new draft) or `{ version, rules }`"],
  "rules.submit": ["approval_rules", "—", "`{ version }`"],
  "rules.publish": ["approval_rules", "—", "`{ version, comment?, override? }`"],
  "rules.reject": ["approval_rules", "—", "`{ version, comment }`"],
  "rules.discard": ["approval_rules", "`{ version }`", "—"],
  "day.prepare": ["recon", "`{ stage }`", "`{ date, stage }` (prepared)"],
  "day.sign": ["recon", "`{ stage }`", "`{ date, stage }` (signed)"],
  "recon.run": ["recon", "–", "`{ runId, version, from, to }` (the published version run over business dates from–to)"],
  "recon.simulate": ["recon", "–", "`{ runId, version, specHash, from, to }` (the draft simulated over business dates from–to)"],
};

export const README = path.join(path.dirname(SCHEMA_DIR), "README.md");
const MARK = /(<!-- actions:start -->\n)[\s\S]*?(<!-- actions:end -->)/;

/** The action table: one row per action of ACTION_LABEL, in that order. */
export function actionTable(): string {
  const rows = Object.entries(ACTION_LABEL).map(([action, label]) => {
    const shape = ACTION_SHAPES[action];
    if (!shape) throw new Error(`no ACTION_SHAPES entry for ${action}`);
    return `| \`${action}\` | ${label} | ${shape.join(" | ")} |`;
  });
  return ["| Action | Label | Target | `before` | `after` |", "|---|---|---|---|---|", ...rows, ""].join("\n");
}

/** README text with the action table regenerated. */
export const withActionTable = (md: string) => md.replace(MARK, (_, start: string, end: string) => `${start}${actionTable()}${end}`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = apiSchemas();
  rmSync(SCHEMA_DIR, { recursive: true, force: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(SCHEMA_DIR, file), text);
  writeFileSync(README, withActionTable(readFileSync(README, "utf8")));
  console.log(`${Object.keys(files).length} schemas → ${path.relative(process.cwd(), SCHEMA_DIR)}; action table → ${path.relative(process.cwd(), README)}`);
}
