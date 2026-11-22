import { describe, expect, it } from "vitest";
import { ConnectorSpec } from "./contracts/integrations";
import { fieldsFromOpenApi, fieldsFromSample, maskTree, maskValue, withPresets } from "./integrations";

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
