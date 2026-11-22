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

type Row = { indent: number; nameCol: number; level: number; numbered: boolean; path: string; field: OpField };
const NUMBERING = /^(?:(\d{1,3})|([ivxlc]{1,7})|([a-z]))[.)]\s*/i;
/** One table row as a field, or null for a header, a wrapped description or prose. `level` = its numbering (1. → 1, i. → 2, a. → 3). */
function tableRow(line: string): Row | null {
  const indent = line.length - line.trimStart().length;
  let rest = line.trim();
  const num = NUMBERING.exec(rest);
  // a lone letter needs a space after it ("a. name"); digits and roman numerals may run into the name ("iii.total")
  const numbered = !!num && !(num[3] && !/\s/.test(num[0].slice(-1)));
  if (numbered) rest = rest.slice(num![0].length);
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
  const level = numbered ? (num![1] ? 1 : num![2] ? 2 : 3) : 0;
  return {
    indent, nameCol: indent + (numbered ? num![0].length : 0), level, numbered, path,
    field: { name, type, ...(maxLength ? { maxLength } : {}), required, ...(type === "object" || type === "array" ? { children: [] } : {}) },
  };
}

/**
 * The fields of a table copied from a spec: a row is "name [M|O] type [length] description" (tabs or spaces). A row
 * belongs to the Object or Array above it by its numbering (1. under the plain rows, i. under 1., a. under i.) or, when
 * not numbered, by its indent; "DE48.TraceID" goes under DE48. A name the layout cut onto the next line (same column,
 * one word) is joined back. `rows` = rows read.
 */
export function fieldsFromTable(text: string): { fields: OpField[]; rows: number } {
  const out: OpField[] = [];
  const stack: { field: OpField; nameCol: number; level: number }[] = [];
  let last: Row | null = null, rows = 0;
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
    if (!r) {
      // the rest of a long name, in the name's column, then only the description column
      const indent = line.length - line.trimStart().length, m = /^(\S+)(\s{2,}.*)?$/.exec(line.trim());
      if (last && indent > last.indent && m && /^[A-Za-z0-9_]+$/.test(m[1]!) && indent <= last.nameCol + 4) last.field.name += m[1];
      else if (line.trim()) last = last && indent > 0 ? last : null;
      continue;
    }
    rows++;
    if (r.numbered) while (stack.length && stack.at(-1)!.level >= r.level) stack.pop();
    else while (stack.length && stack.at(-1)!.nameCol >= r.nameCol) stack.pop();
    const level = r.numbered ? r.level : stack.length ? stack.at(-1)!.level + 1 : 0;
    const parent = stack.at(-1)?.field.children;
    if (parent) parent.push(r.field); else under(out, r.path.split("."), r.field);
    if (r.field.children) stack.push({ field: r.field, nameCol: r.nameCol, level });
    last = r;
  }
  const tidy = (fs: OpField[]): OpField[] => fs.map((f) => (f.children ? (f.children.length ? { ...f, children: tidy(f.children) } : (({ children: _, ...x }) => x)(f)) : f));
  return { fields: tidy(out), rows };
}

/** Table fields whose name a sample shows longer (a name the spec's layout cut short) take the sample's name. */
export function completeNames(fields: readonly OpField[], sample: unknown): OpField[] {
  const obj = Array.isArray(sample) ? sample[0] : sample;
  if (obj === null || typeof obj !== "object") return [...fields];
  const keys = Object.keys(obj as object);
  return fields.map((f) => {
    let name = f.name;
    if (!keys.includes(name)) {
      const longer = keys.filter((k) => k.startsWith(name) && k !== name && !fields.some((x) => x.name === k));
      if (longer.length === 1) name = longer[0]!;
    }
    const inner = (obj as Record<string, unknown>)[name];
    return { ...f, name, ...(f.children ? { children: completeNames(f.children, inner) } : {}) };
  });
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

// ---- a whole spec pasted at once: one operation per section that has a Method line ----
export type SpecOperation = {
  key: string; name: string; method: "POST" | "GET" | "PUT"; path: string; request: OpField[]; response: OpField[];
  /** Suggested from the data: a response code field = "00". */
  success: { field: string; equals: string } | null;
};
const TITLE = /^(\d+(?:\.\d+)*)\.?\s+([A-Za-z].{0,79}?)\s*$/;
const keyOf = (name: string) => { const k = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40); return /^[a-z]/.test(k) ? k : `op_${k}`.slice(0, 40); };
const braces = (s: string) => [...s].reduce((n, c) => n + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);

/**
 * Operations read from a spec pasted whole: each section's title (the numbered heading above it), Method, Path (an
 * absolute URL gives the address; wrapped lines joined), and its Request and Response field tables (a sample JSON when
 * a side has no table). Header tables are skipped. `baseUrl` = the address of the first absolute path.
 */
export function operationsFromSpec(text: string): { operations: SpecOperation[]; baseUrl: string | null } {
  type Draft = { name: string; method: SpecOperation["method"]; url: string; table: Record<"request" | "response", string[]>; sample: Record<"request" | "response", string> };
  const drafts: Draft[] = [];
  let title: string | null = null, op: Draft | null = null;
  let section: "header" | "request" | "response" | null = null, inPath = false;
  let sample: { side: "request" | "response"; depth: number } | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const s = line.trim(), indent = line.length - line.trimStart().length;
    if (sample && op) {
      op.sample[sample.side] += `\n${line}`;
      sample.depth += braces(line);
      if (sample.depth <= 0) sample = null;
      continue;
    }
    if (inPath && op) {
      if (s && indent > 0 && !/\s/.test(s) && !/^(Header|Headers|Request|Response)$/i.test(s)) { op.url += s; continue; }
      inPath = false;
    }
    const m = /^(?:HTTP\s+)?Method\s*:?\s+(POST|GET|PUT)\b/i.exec(s);
    if (m) {
      op = { name: title ?? `Operation ${drafts.length + 1}`, method: m[1]!.toUpperCase() as SpecOperation["method"], url: "", table: { request: [], response: [] }, sample: { request: "", response: "" } };
      drafts.push(op); section = null; continue;
    }
    const p = /^(?:Path|URL|Endpoint)\s*:?\s+(\S+)$/i.exec(s);
    if (p && op) { op.url = p[1]!; inPath = true; continue; }
    const smp = /^(Request|Response)\s+(\{.*)$/i.exec(s);
    if (smp && op) {
      const side = smp[1]!.toLowerCase() as "request" | "response";
      op.sample[side] = smp[2]!;
      const depth = braces(smp[2]!);
      if (depth > 0) sample = { side, depth };
      continue;
    }
    if (/^(Header|Headers)$/i.test(s)) { section = "header"; continue; }
    const sec = /^(Request|Response)(?:\s+(?:Body|Parameters?))?$/i.exec(s);
    if (sec) { section = sec[1]!.toLowerCase() as "request" | "response"; continue; }
    const t = indent < 4 && !/\.{4,}/.test(s) ? TITLE.exec(s) : null;
    if (t && !tableRow(line)) { title = t[2]!; if (op && section) section = null; continue; }
    if (op && (section === "request" || section === "response")) op.table[section].push(line);
  }
  let baseUrl: string | null = null;
  const used = new Set<string>();
  const operations = drafts.map((d): SpecOperation => {
    let path = d.url || "/";
    if (/^https?:\/\//i.test(path)) {
      try { const u = new URL(path); baseUrl ??= u.origin; path = `${u.pathname}${u.search}`; } catch { /* not a URL: kept as typed */ }
    }
    if (!path.startsWith("/")) path = `/${path}`;
    const side = (k: "request" | "response") => {
      let sampled: unknown;
      try { sampled = d.sample[k] ? JSON.parse(d.sample[k]) : undefined; } catch { sampled = undefined; }
      const fromTable = fieldsFromTable(d.table[k].join("\n")).fields;
      if (fromTable.length) return sampled === undefined ? fromTable : completeNames(fromTable, sampled);
      return sampled === undefined ? [] : fieldsFromSample(sampled);
    };
    const request = side("request"), response = side("response");
    const code = fieldPaths(response).find((x) => /^(rs)?responsecode$/i.test(x.split(".").at(-1)!));
    let key = keyOf(d.name), n = 2;
    while (used.has(key)) key = `${keyOf(d.name).slice(0, 36)}_${n++}`;
    used.add(key);
    return { key, name: d.name, method: d.method, path, request, response, success: code ? { field: code, equals: "00" } : null };
  });
  return { operations, baseUrl };
}
