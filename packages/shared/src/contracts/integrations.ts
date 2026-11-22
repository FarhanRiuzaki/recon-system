import { z } from "zod";
import { CONNECTOR_SORTS } from "../paging";
import { DESCRIPTION_MAX, ENVIRONMENTS, FIELD_TYPES, FIELDS_MAX, fieldPaths, type OpField as OpFieldT, OPERATIONS_MAX, PROFILES, RESERVED_NAMES, TIMEOUT_MAX_MS, TIMEOUT_MIN_MS } from "../integrations";
import { ListQuery, sortParam } from "./common";
import { Person, reviewFields, versionFields } from "./workflows";

// Open API connectors (DEC-053, spec §4.2): a connector's reviewed version (its environments' settings and its
// operations with their field trees) and its secrets per environment, which no answer ever carries.

const OpField: z.ZodType<OpFieldT> = z.lazy(() => z.strictObject({
  name: z.string().trim().min(1).max(80).refine((n) => !RESERVED_NAMES.includes(n), "Pick another name: this one is reserved."),
  type: z.enum(FIELD_TYPES),
  maxLength: z.number().int().min(1).max(10000).optional(),
  required: z.boolean(),
  /** What the spec says of the field (kept from a paste; shown, and read for auto values). */
  description: z.string().max(DESCRIPTION_MAX).optional(),
  children: z.array(OpField).max(FIELDS_MAX).optional(),
}));
const count = (fs: readonly OpFieldT[]): number => fs.reduce((n, f) => n + 1 + (f.children ? count(f.children) : 0), 0);
const DotPath = z.string().trim().min(1).max(300);

export const OperationSpec = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and _ for the key, starting with a letter."),
  name: z.string().trim().min(1, "Name the operation.").max(80),
  method: z.enum(["POST", "GET", "PUT"]),
  path: z.string().trim().regex(/^\/[^\s]*$/, "Start the path with /, without spaces.").max(300),
  timeoutMs: z.number().int().min(TIMEOUT_MIN_MS).max(TIMEOUT_MAX_MS),
  request: z.array(OpField).max(FIELDS_MAX),
  response: z.array(OpField).max(FIELDS_MAX),
  /** Success when the response field at `field` equals `equals` (e.g. ResponseCode = "00"); null = any readable answer. */
  success: z.strictObject({ field: DotPath, equals: z.string().max(40) }).nullable(),
  /** The response field kept as the bank's reference. */
  reference: DotPath.nullable(),
  /** Request or response fields shown and stored masked. */
  masked: z.array(DotPath).max(FIELDS_MAX),
  /** Fixed values of request fields (dot path → value). */
  presets: z.record(DotPath, z.string().max(500)),
  /** Request fields the system fills on every call (dot path → how): never typed, shown as "Auto generated". */
  auto: z.record(DotPath, z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("external_id") }),
    z.strictObject({ kind: z.literal("now"), format: z.string().trim().min(1).max(60) }),
  ])).default({}),
}).superRefine((o, ctx) => {
  if (count(o.request) + count(o.response) > FIELDS_MAX) ctx.addIssue({ code: "custom", message: `An operation has at most ${FIELDS_MAX} fields.` });
  const res = new Set(fieldPaths(o.response)), req = new Set(fieldPaths(o.request));
  if (o.success && !res.has(o.success.field)) ctx.addIssue({ code: "custom", path: ["success", "field"], message: "Pick a response field for success." });
  if (o.reference && !res.has(o.reference)) ctx.addIssue({ code: "custom", path: ["reference"], message: "Pick a response field for the reference." });
  for (const p of Object.keys(o.presets)) if (!req.has(p)) ctx.addIssue({ code: "custom", path: ["presets", p], message: "A fixed value is for a request field." });
  for (const p of Object.keys(o.auto)) {
    if (!req.has(p)) ctx.addIssue({ code: "custom", path: ["auto", p], message: "An auto value is for a request field." });
    else if (p in o.presets) ctx.addIssue({ code: "custom", path: ["auto", p], message: "A field is either fixed or auto, not both." });
  }
});
export type OperationSpec = z.infer<typeof OperationSpec>;

export const EnvironmentSettings = z.strictObject({
  /** Empty in a draft until it is known; a call to it then says to enter it. */
  baseUrl: z.string().trim().max(300).refine((u) => u === "" || /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(u), "Use an https:// address."),
  host: z.string().trim().max(200),
  partnerId: z.string().trim().max(64),
  channelId: z.string().trim().max(64),
  /**
   * Check the bank's TLS certificate (against the CA bundle, else the server's): off by default, as the bank's internal
   * endpoints are called (owner, 22 Nov; Recon-QR does not check); the body stays encrypted by the profile either way.
   */
  verifyTls: z.boolean().default(false),
});
export type EnvironmentSettings = z.infer<typeof EnvironmentSettings>;

/** A connector's version: its name, security profile, active environment, environments and operations. */
export const ConnectorSpec = z.strictObject({
  name: z.string().trim().min(1, "Name the connector.").max(80),
  profile: z.enum(PROFILES),
  active: z.enum(ENVIRONMENTS),
  environments: z.strictObject({ dev: EnvironmentSettings, prod: EnvironmentSettings }),
  operations: z.array(OperationSpec).max(OPERATIONS_MAX),
}).superRefine((c, ctx) => {
  const keys = c.operations.map((o) => o.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["operations"], message: "Give each operation its own key." });
});
export type ConnectorSpec = z.infer<typeof ConnectorSpec>;

export const ConnectorVersionDto = z.object({ ...versionFields, spec: ConnectorSpec });
export type ConnectorVersionDto = z.infer<typeof ConnectorVersionDto>;
const SecretFlags = z.object({ clientId: z.boolean(), clientSecret: z.boolean(), publicKey: z.boolean(), caBundle: z.boolean() });
/** GET /integrations/connectors: a connector, its live and open version. */
export const ConnectorRowDto = z.object({
  id: z.string(), name: z.string(), profile: z.enum(PROFILES), active: z.enum(ENVIRONMENTS).nullable(), operations: z.number().int(),
  published: z.object({ version: z.number().int(), decidedAt: z.string().nullable() }).nullable(),
  open: z.object({ version: z.number().int(), status: z.enum(["draft", "in_review"]), updatedAt: z.string() }).nullable(),
  disabled: z.boolean(), updatedAt: z.string(),
  /**
   * The bank link in the live version's active environment, from its circuit: `answered` (the last call got an answer),
   * `failing` (`failures` calls in a row got none, or the pause after them ended without an answer since), `paused` (calls
   * not sent for now), `none` (never called there).
   */
  link: z.object({ state: z.enum(["answered", "failing", "paused", "none"]), failures: z.number().int() }),
  /** Recons, in every space, whose live version has an action that calls it. */
  usedBy: z.number().int(),
});
export type ConnectorRowDto = z.infer<typeof ConnectorRowDto>;
/** GET /integrations/connectors/{id}: its versions, which secrets are set per environment (never their values). */
export const ConnectorDetailDto = z.object({
  id: z.string(), name: z.string(), published: ConnectorVersionDto.nullable(), open: ConnectorVersionDto.nullable(),
  secrets: z.object({ dev: SecretFlags, prod: SecretFlags }),
  disabled: z.object({ at: z.string(), reason: z.string(), by: Person.nullable() }).nullable(),
  ...reviewFields,
});
export type ConnectorDetailDto = z.infer<typeof ConnectorDetailDto>;

export const ConnectorListQuery = ListQuery.extend({ sort: sortParam(CONNECTOR_SORTS) });
export type ConnectorListQuery = z.infer<typeof ConnectorListQuery>;
export const CreateConnectorBody = z.strictObject({ spec: ConnectorSpec });
export type CreateConnectorBody = z.infer<typeof CreateConnectorBody>;
export const SaveConnectorBody = z.strictObject({ spec: ConnectorSpec });
export type SaveConnectorBody = z.infer<typeof SaveConnectorBody>;
/** PUT …/secrets: the values to replace in one environment (left out = kept). */
export const ReplaceSecretsBody = z.strictObject({
  environment: z.enum(ENVIRONMENTS),
  clientId: z.string().trim().min(1).max(200).optional(),
  clientSecret: z.string().trim().min(1).max(500).optional(),
  publicKey: z.string().trim().min(1).max(10000).optional(),
  caBundle: z.string().trim().min(1).max(60000).optional(),
}).refine((b) => b.clientId || b.clientSecret || b.publicKey || b.caBundle, "Enter at least one value to replace.");
export type ReplaceSecretsBody = z.infer<typeof ReplaceSecretsBody>;
export const DisableConnectorBody = z.strictObject({ reason: z.string().trim().min(1, "Say why it is turned off.").max(500) });
export type DisableConnectorBody = z.infer<typeof DisableConnectorBody>;
export const TokenCheckBody = z.strictObject({ environment: z.enum(ENVIRONMENTS) });
export type TokenCheckBody = z.infer<typeof TokenCheckBody>;
export const TokenCheckDto = z.object({ ok: z.boolean(), expiresIn: z.number().int().nullable(), message: z.string() });
export type TokenCheckDto = z.infer<typeof TokenCheckDto>;
/** POST …/try: one operation of the connector's open or live version, to the dev environment, with a JSON body. */
export const TryBody = z.strictObject({ operation: z.string().max(40), body: z.unknown() });
export type TryBody = z.infer<typeof TryBody>;
export const TryDto = z.object({
  ok: z.boolean(), outcome: z.enum(["ok", "rejected", "not_sent", "timeout"]), status: z.number().int().nullable(), ms: z.number().int(),
  externalId: z.string().nullable(), success: z.boolean().nullable(), reference: z.string().nullable(), response: z.unknown().nullable(), raw: z.string().nullable(),
  message: z.string(),
  /** The auto values the system filled for this call (dot path → value). */
  filled: z.record(z.string(), z.string()),
});
export type TryDto = z.infer<typeof TryDto>;

/** GET /spaces/{spaceId}/connector-operations: what a recon's action may pick (stage 4): connectors, versions published once, operations. */
export const ConnectorOperationsDto = z.object({
  items: z.array(z.object({
    id: z.string(), name: z.string(), disabled: z.boolean(),
    versions: z.array(z.object({
      version: z.number().int(), live: z.boolean(),
      operations: z.array(z.object({ key: z.string(), name: z.string(), method: z.string(), path: z.string(), request: z.array(OpField), fixed: z.array(z.string()), auto: z.array(z.string()) })),
    })),
  })),
});
export type ConnectorOperationsDto = z.infer<typeof ConnectorOperationsDto>;
