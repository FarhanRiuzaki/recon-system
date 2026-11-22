import { describe, expect, it } from "vitest";
import { ConnectorSpec } from "./contracts/integrations";
import { fieldsFromOpenApi, fieldsFromSample, fieldsFromTable, maskTree, maskValue, readSpecPaste, withPresets } from "./integrations";

describe("field trees", () => {
  it("reads a sample JSON into a field tree", () => {
    expect(fieldsFromSample({ ResponseCode: "00", Amount: 1500, DE48: { TraceID: "1" }, Items: [{ a: "x" }] })).toEqual([
      { name: "ResponseCode", type: "string", required: false },
      { name: "Amount", type: "numeric", required: false },
      { name: "DE48", type: "object", required: false, children: [{ name: "TraceID", type: "string", required: false }] },
      { name: "Items", type: "array", required: false, children: [{ name: "a", type: "string", required: false }] },
    ]);
  });
  it("reads an OpenAPI 3 operation's request and response, following component refs", () => {
    const doc = {
      paths: { "/x": { post: {
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Req" } } } },
        responses: { 200: { content: { "application/json": { schema: { type: "object", properties: { ResponseCode: { type: "string" } } } } } } },
      } } },
      components: { schemas: { Req: { type: "object", required: ["A"], properties: { A: { type: "string", maxLength: 10 } } } } },
    };
    expect(fieldsFromOpenApi(doc, "/x", "POST")).toEqual({
      request: [{ name: "A", type: "string", maxLength: 10, required: true }],
      response: [{ name: "ResponseCode", type: "string", required: false }],
    });
    expect(fieldsFromOpenApi(doc, "/y", "POST")).toBe("This file has no POST /y.");
  });
});

describe("masking", () => {
  it("keeps the first and last two characters of a long value", () => {
    expect(maskValue("1234567890")).toBe("12******90");
    expect(maskValue("abc")).toBe("***");
    expect(maskTree({ a: { b: "1234567890" }, c: "x" }, ["a.b"])).toEqual({ a: { b: "12******90" }, c: "x" });
  });
});

describe("ConnectorSpec", () => {
  const env = { baseUrl: "https://api.bank.local:15000", host: "api.bank.local", partnerId: "P1", channelId: "C1" };
  const op = { key: "post", name: "Misc debit credit", method: "POST", path: "/openapi/v2.0/misc/debit-credit", timeoutMs: 30000,
    request: [{ name: "Amount", type: "numeric", required: true }], response: [{ name: "ResponseCode", type: "string", required: false }],
    success: { field: "ResponseCode", equals: "00" }, reference: null, masked: [], presets: {} };
  const spec = { name: "Bank Mega", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [op] };
  const issue = (v: unknown) => ConnectorSpec.safeParse(v).error?.issues.map((i) => i.message);
  it("takes a connector with an https address and distinct operations", () => {
    expect(ConnectorSpec.safeParse(spec).success).toBe(true);
  });
  it("refuses http, a repeated operation key and a success field the response doesn't have", () => {
    expect(issue({ ...spec, environments: { dev: { ...env, baseUrl: "http://x" }, prod: env } })).toContain("Use an https:// address.");
    expect(issue({ ...spec, operations: [op, op] })).toContain("Give each operation its own key.");
    expect(issue({ ...spec, operations: [{ ...op, success: { field: "Nope", equals: "00" } }] })).toContain("Pick a response field for success.");
  });
});

describe("fixed values (final review I1)", () => {
  it("fill what the body leaves out, never touch Object.prototype, and skip a path through a value that isn't an object", () => {
    expect(withPresets({ Amount: "1" }, { Currency: "IDR", "DE48.Cur": "IDR" })).toEqual({ Amount: "1", Currency: "IDR", DE48: { Cur: "IDR" } });
    expect(withPresets({ Currency: "USD" }, { Currency: "IDR" })).toEqual({ Currency: "USD" });
    withPresets({}, { "constructor.prototype.polluted": "yes", "__proto__.polluted": "yes" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(withPresets({ DE48: "abc" }, { "DE48.Cur": "IDR" })).toEqual({ DE48: "abc" });
  });
  it("a field can't be named __proto__, constructor or prototype", () => {
    const env = { baseUrl: "", host: "", partnerId: "", channelId: "" };
    const op = { key: "a", name: "A", method: "POST", path: "/", timeoutMs: 30000, request: [{ name: "constructor", type: "object", required: false }], response: [], success: null, reference: null, masked: [], presets: {} };
    const r = ConnectorSpec.safeParse({ name: "X", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [op] });
    expect(r.error?.issues.map((i) => i.message)).toContain("Pick another name: this one is reserved.");
  });
});

describe("a field table pasted from a bank's spec", () => {
  it("reads name, mandatory, type and length per row; wrapped descriptions and header rows are skipped", () => {
    const table = [
      "Request",
      "Field                             Type    Data Type        Length     Description",
      "fromDate                          M       String           25         Range start, ISO date time.",
      "                                                                      Up to 90 days back.",
      "pageSize                          O       Integer          5          Rows per page.",
      "amount\tM\tNumeric\t16,2\tAmount in rupiah",
    ].join("\n");
    expect(fieldsFromTable(table)).toEqual({ fields: [
      { name: "fromDate", type: "string", maxLength: 25, required: true },
      { name: "pageSize", type: "numeric", maxLength: 5, required: false },
      { name: "amount", type: "numeric", maxLength: 16, required: true },
    ], rows: 3 });
  });
  it("nests numbered rows under the Object above them, and dotted names under their parent", () => {
    const table = [
      "Field                                      Data Type         Description",
      "responseHeader                             Object",
      "    1.  rsCode                             String            Response code",
      "    2.  rsHasMore                          String            More rows follow",
      "    3.  rsTotal                            Numeric           Rows in all",
      "detail                                     Object",
      "1. bankCode String Participant BIC",
      "note String A plain field after the groups",
      "DE48.TraceID M String 12 Trace",
    ].join("\n");
    expect(fieldsFromTable(table).fields).toEqual([
      { name: "responseHeader", type: "object", required: false, children: [
        { name: "rsCode", type: "string", required: false }, { name: "rsHasMore", type: "string", required: false }, { name: "rsTotal", type: "numeric", required: false },
      ] },
      { name: "detail", type: "object", required: false, children: [{ name: "bankCode", type: "string", required: false }] },
      { name: "note", type: "string", required: false },
      { name: "DE48", type: "object", required: false, children: [{ name: "TraceID", type: "string", maxLength: 12, required: true }] },
    ]);
  });
  it("reads nothing from text that has no field rows (headers of the HTTP call, prose)", () => {
    expect(fieldsFromTable("X-PARTNER-ID   M   {{x-partner-id}}   Partner\nSome prose about the API.").fields).toEqual([]);
  });
  it("tells a pasted sample, an OpenAPI file and a table apart", () => {
    expect(readSpecPaste('{ "ResponseCode": "00" }', "/x", "POST", "response")).toEqual({ fields: [{ name: "ResponseCode", type: "string", required: false }], from: "sample" });
    expect(readSpecPaste("code M String 2 Code", "/x", "POST", "request")).toEqual({ fields: [{ name: "code", type: "string", maxLength: 2, required: true }], from: "table" });
    expect(readSpecPaste('{ "openapi": "3.0.0", "paths": {} }', "/x", "POST", "request")).toBe("This file has no POST /x.");
    expect(readSpecPaste("just words", "/x", "POST", "request")).toBe("No fields were found. Paste the field table, a sample JSON or an OpenAPI file from the spec.");
  });
});
