// The largest request body, in the web (BFF) and the API alike (AGENTS §3: 64 KB). A source version's spec is the one
// body that grows with its data: 500 columns with long names and their stored names come to about 140 KB (owner,
// 21 Nov: tables of 200+ columns), so saving a version and previewing it take up to SPEC_BODY_MAX; a connector's draft
// (operations with their field trees) too; nothing else does.

export const BODY_MAX = 64 * 1024;
export const SPEC_BODY_MAX = 512 * 1024;

/** PATCH …/sources/{id}/versions/{id} (the draft's spec) and POST …/versions/{id}/preview, as /v1 paths. */
const SPEC_PATH = /^\/v1\/spaces\/[0-9a-f-]{36}\/sources\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}(?:\/preview)?$/i;

/** PATCH …/integrations/connectors/{id}/draft: a connector's operations with their field trees (DEC-053). */
const CONNECTOR_PATH = /^\/v1\/integrations\/connectors\/[0-9a-f-]{36}\/draft$/i;

/** The body limit of the /v1 path `path` (its query left out). */
export const bodyMaxFor = (path: string): number => { const p = path.split("?")[0]!; return SPEC_PATH.test(p) || CONNECTOR_PATH.test(p) ? SPEC_BODY_MAX : BODY_MAX; };
