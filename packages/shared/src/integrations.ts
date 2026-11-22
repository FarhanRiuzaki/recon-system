// Open API connectors (DEC-053, spec 2026-11-22-recon-approval-and-posting §4.2), zod-free and pure: an operation's
// field trees (read from a sample JSON or an OpenAPI file), masking of stored or shown values, the fixed lists.

export const ENVIRONMENTS = ["dev", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
export const ENVIRONMENT_LABEL: Record<Environment, string> = { dev: "Development", prod: "Production" };
export const PROFILES = ["bank_mega_openapi_2_1"] as const;
export const PROFILE_LABEL: Record<(typeof PROFILES)[number], string> = { bank_mega_openapi_2_1: "Bank Mega Open API · security 2.1" };
export const FIELD_TYPES = ["string", "numeric", "boolean", "object", "array"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type OpField = { name: string; type: FieldType; maxLength?: number; required: boolean; children?: OpField[] };
export const OPERATIONS_MAX = 50;
export const FIELDS_MAX = 400;
export const TIMEOUT_MIN_MS = 1000, TIMEOUT_MAX_MS = 60000, TIMEOUT_DEFAULT_MS = 30000;

const typeOf = (v: unknown): FieldType =>
  Array.isArray(v) ? "array" : v !== null && typeof v === "object" ? "object" : typeof v === "number" ? "numeric" : typeof v === "boolean" ? "boolean" : "string";

/** A sample JSON object as a field tree (an array's fields from its first element); nothing is required. */
export function fieldsFromSample(json: unknown): OpField[] {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return [];
  return Object.entries(json as Record<string, unknown>).map(([name, v]) => {
    const type = typeOf(v);
    const inner = type === "array" ? (v as unknown[])[0] : v;
    const children = type === "object" || (type === "array" && inner !== null && typeof inner === "object") ? fieldsFromSample(inner) : null;
    return { name, type, required: false, ...(children ? { children } : {}) };
  });
}

type Schema = { $ref?: string; type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; maxLength?: number };
const REF = /^#\/components\/schemas\/(.+)$/;
function fromSchema(doc: { components?: { schemas?: Record<string, Schema> } }, s: Schema | undefined, depth: number): OpField[] {
  const resolved = (x: Schema | undefined): Schema | undefined => {
    const m = x?.$ref ? REF.exec(x.$ref) : null;
    return m ? doc.components?.schemas?.[m[1]!] : x;
  };
  const o = resolved(s);
  if (!o?.properties || depth > 8) return [];
  return Object.entries(o.properties).map(([name, raw]) => {
    const p = resolved(raw) ?? {};
    const type: FieldType = p.type === "integer" || p.type === "number" ? "numeric" : p.type === "boolean" ? "boolean" : p.type === "array" ? "array" : p.properties || p.type === "object" ? "object" : "string";
    const children = type === "object" ? fromSchema(doc, p, depth + 1) : type === "array" ? fromSchema(doc, p.items, depth + 1) : [];
    return { name, type, ...(p.maxLength ? { maxLength: p.maxLength } : {}), required: !!o.required?.includes(name), ...(children.length ? { children } : {}) };
  });
}
/** An OpenAPI 3 operation's JSON request and its 200 (or first 2xx) response as field trees, or why it can't. */
export function fieldsFromOpenApi(doc: unknown, path: string, method: string): { request: OpField[]; response: OpField[] } | string {
  const d = doc as { paths?: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> }; responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }>> };
  const op = d?.paths?.[path]?.[method.toLowerCase()];
  if (!op) return `This file has no ${method.toUpperCase()} ${path}.`;
  const json = (c?: Record<string, { schema?: Schema }>) => c?.["application/json"]?.schema;
  const ok = op.responses?.["200"] ?? Object.entries(op.responses ?? {}).find(([k]) => k.startsWith("2"))?.[1];
  return { request: fromSchema(d as never, json(op.requestBody?.content), 0), response: fromSchema(d as never, json(ok?.content), 0) };
}

/** A value shown or stored masked: the first and last two characters of 7 or more, else all hidden. */
export const maskValue = (v: string): string => (v.length >= 7 ? `${v.slice(0, 2)}${"*".repeat(v.length - 4)}${v.slice(-2)}` : "*".repeat(v.length));
/** `json` with the values at `paths` (dot paths; inside arrays every element) masked. */
export function maskTree(json: unknown, paths: readonly string[]): unknown {
  const at = (v: unknown, parts: string[]): unknown => {
    if (Array.isArray(v)) return v.map((x) => at(x, parts));
    if (!parts.length) return v === null || v === undefined || typeof v === "object" ? v : maskValue(String(v));
    if (v === null || typeof v !== "object") return v;
    const [head, ...rest] = parts;
    return Object.hasOwn(v, head!) ? { ...(v as Record<string, unknown>), [head!]: at((v as Record<string, unknown>)[head!], rest) } : v;
  };
  return paths.reduce((acc, p) => at(acc, p.split(".")), json);
}
/** Every dot path of a field tree (arrays' children under the array's name). */
export const fieldPaths = (fields: readonly OpField[], prefix = ""): string[] =>
  fields.flatMap((f) => [`${prefix}${f.name}`, ...(f.children ? fieldPaths(f.children, `${prefix}${f.name}.`) : [])]);
/** The value at a dot path of a JSON value, or undefined. */
export function readPath(json: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined), json);
}

/** Names a field can't have: they would reach an object's prototype. */
export const RESERVED_NAMES: readonly string[] = ["__proto__", "constructor", "prototype"];
const own = (o: object, k: string) => Object.hasOwn(o, k);
/**
 * The request body with the operation's fixed values where the body leaves them out. A path through a reserved name,
 * or through a value that isn't a plain object, is skipped; the body is never changed in place.
 */
export function withPresets(body: unknown, presets: Readonly<Record<string, string>>): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const out = structuredClone(isObj(body) ? body : {});
  for (const [path, v] of Object.entries(presets)) {
    const parts = path.split(".");
    if (parts.some((p) => RESERVED_NAMES.includes(p))) continue;
    let at: Record<string, unknown> | null = out;
    for (const p of parts.slice(0, -1)) {
      if (!own(at, p)) at[p] = {};
      const next: unknown = at[p];
      at = isObj(next) ? next : null;
      if (!at) break;
    }
    const last = parts.at(-1)!;
    if (at && !own(at, last)) at[last] = v;
  }
  return out;
}

// ---- a field table copied from a bank's spec (PDF or Word): one row per field, wrapped descriptions in between ----
const TYPE_WORDS: Record<string, FieldType> = {
  string: "string", alphanumeric: "string", an: "string", ans: "string", char: "string", varchar: "string", text: "string", date: "string", datetime: "string", time: "string",
  numeric: "numeric", number: "numeric", integer: "numeric", int: "numeric", long: "numeric", decimal: "numeric", double: "numeric", amount: "numeric", n: "numeric",
  boolean: "boolean", bool: "boolean", object: "object", array: "array", list: "array",
};
/** M / O / C as specs mark them ("N" is the numeric type, as ISO-style specs write it). */
const MANDATORY: Record<string, boolean> = { m: true, mandatory: true, required: true, y: true, yes: true, o: false, optional: false, c: false, conditional: false, no: false };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** One table row as a field, or null for a header, a wrapped description or prose. */
function tableRow(line: string): { indent: number; numbered: boolean; path: string; field: OpField } | null {
  const indent = line.length - line.trimStart().length;
  let rest = line.trim();
  const num = /^\d+[.)]\s+/.exec(rest);
  if (num) rest = rest.slice(num[0].length);
  const t = rest.split(/\s+/);
  if (!t[0] || !NAME.test(t[0])) return null;
  let required = false, type: FieldType | null = null, maxLength: number | undefined, i = 1;
  for (; i < Math.min(t.length, 4) && !type; i++) {
    const w = t[i]!.toLowerCase();
    if (TYPE_WORDS[w]) type = TYPE_WORDS[w]!;
    else if (MANDATORY[w] !== undefined) required = MANDATORY[w]!;
    else return null;
  }
  if (!type) return null;
  const len = t[i] ? /^(\d{1,5})(?:[,.]\d+)?$/.exec(t[i]!) : null;
  if (len && type !== "object" && type !== "array") maxLength = Number(len[1]);
  const path = t[0];
  const name = path.split(".").at(-1)!;
  return { indent, numbered: !!num, path, field: { name, type, ...(maxLength ? { maxLength } : {}), required, ...(type === "object" || type === "array" ? { children: [] } : {}) } };
}

/**
 * The fields of a table copied from a spec: a row is "name [M|O] type [length] description" (tabs or spaces); rows
 * numbered "1." or indented under an Object/Array row are its fields; "DE48.TraceID" goes under DE48. `rows` = rows read.
 */
export function fieldsFromTable(text: string): { fields: OpField[]; rows: number } {
  const out: OpField[] = [];
  let group: { field: OpField; indent: number } | null = null, rows = 0;
  const under = (parent: OpField[], parts: string[], f: OpField) => {
    let at = parent;
    for (const p of parts.slice(0, -1)) {
      let g = at.find((x) => x.name === p && x.children);
      if (!g) { g = { name: p, type: "object", required: false, children: [] }; at.push(g); }
      at = g.children!;
    }
    at.push(f);
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const r = tableRow(line);
    if (!r) continue;
    rows++;
    const child = !!group && (r.numbered || r.indent > group.indent);
    if (child) group!.field.children!.push(r.field);
    else {
      under(out, r.path.split("."), r.field);
      group = r.field.children ? { field: r.field, indent: r.indent } : null;
    }
  }
  const tidy = (fs: OpField[]): OpField[] => fs.map((f) => (f.children ? (f.children.length ? { ...f, children: tidy(f.children) } : (({ children: _, ...x }) => x)(f)) : f));
  return { fields: tidy(out), rows };
}

/** What a paste from a spec holds: an OpenAPI file, a sample JSON or a field table; the fields, or why none. */
export function readSpecPaste(text: string, path: string, method: string, side: "request" | "response"): { fields: OpField[]; from: "openapi" | "sample" | "table" } | string {
  const none = "No fields were found. Paste the field table, a sample JSON or an OpenAPI file from the spec.";
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (json !== undefined && json !== null && typeof json === "object") {
    const doc = json as Record<string, unknown>;
    if ("paths" in doc || "openapi" in doc || "swagger" in doc) {
      const r = fieldsFromOpenApi(doc, path, method);
      return typeof r === "string" ? r : r[side].length ? { fields: r[side], from: "openapi" } : none;
    }
    const f = fieldsFromSample(json);
    return f.length ? { fields: f, from: "sample" } : none;
  }
  const t = fieldsFromTable(text);
  return t.fields.length ? { fields: t.fields, from: "table" } : none;
}
