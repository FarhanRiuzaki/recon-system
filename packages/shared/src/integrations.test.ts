import { describe, expect, it } from "vitest";
import { ConnectorSpec } from "./contracts/integrations";
import { completeNames, formatNow, suggestAuto, withAuto, fieldsFromOpenApi, fieldsFromSample, fieldsFromTable, maskTree, maskValue, operationsFromSpec, readSpecPaste, withPresets } from "./integrations";

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
    expect(fieldsFromTable(table)).toMatchObject({ fields: [
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
    expect(fieldsFromTable(table).fields).toMatchObject([
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
    expect(readSpecPaste("code M String 2 Code", "/x", "POST", "request")).toMatchObject({ fields: [{ name: "code", type: "string", maxLength: 2, required: true }], from: "table" });
    expect(readSpecPaste('{ "openapi": "3.0.0", "paths": {} }', "/x", "POST", "request")).toBe("This file has no POST /x.");
    expect(readSpecPaste("just words", "/x", "POST", "request")).toBe("No fields were found. Paste the field table, a sample JSON or an OpenAPI file from the spec.");
  });
});

describe("a whole spec pasted at once: one operation per section", () => {
  const spec = [
    "Table of contents",
    "1. Balance Inquiry......................................................3",
    "2. Fund Status..........................................................5",
    "1. Balance Inquiry",
    "",
    "Method               POST",
    "Path                 https://api.bank.local:15000/openapi/v1.0/demo/",
    "                     balance-inquiry",
    "",
    "Header",
    "Field                        Type     Value                             Description",
    "Authorization                M        Bearer {{access_token}}           Bearer token",
    "X-PARTNER-ID                 M        {{partner-id}}                    Partner",
    "",
    "Request",
    "Field                             Type    Data Type        Length     Description",
    "accountNo                         M       String           16         Account to read.",
    "                                                                      Digits only.",
    "",
    "Response",
    "Field                                      Data Type         Description",
    "header                                     Object",
    "    1.  rsResponseCode                     String            Response code",
    "    2.  rsResponseMsg                      String            Message",
    "balance                                    Numeric           Balance now",
    "",
    "Request              {",
    '                         "accountNo": "123"',
    "                     }",
    "2. Fund Status",
    "Method               GET",
    "Path                 https://api.bank.local:15000/openapi/v1.0/demo/fund-status?type=a",
    "Response",
    "Response             {",
    '                         "ResponseCode": "00",',
    '                         "Status": "OK"',
    "                     }",
  ].join("\n");
  it("reads each section's name, method, path (wrapped lines joined), request and response fields, and the address", () => {
    const r = operationsFromSpec(spec);
    expect(r.baseUrl).toBe("https://api.bank.local:15000");
    expect(r.operations.map((o) => [o.key, o.name, o.method, o.path])).toEqual([
      ["balance_inquiry", "Balance Inquiry", "POST", "/openapi/v1.0/demo/balance-inquiry"],
      ["fund_status", "Fund Status", "GET", "/openapi/v1.0/demo/fund-status?type=a"],
    ]);
    expect(r.operations[0]!.request).toMatchObject([{ name: "accountNo", type: "string", maxLength: 16, required: true }]);
    expect(r.operations[0]!.response.map((f) => f.name)).toEqual(["header", "balance"]);
    // no table: the sample answers the fields
    expect(r.operations[1]!.response).toEqual([{ name: "ResponseCode", type: "string", required: false }, { name: "Status", type: "string", required: false }]);
  });
  it("suggests success when the response has a response code", () => {
    const r = operationsFromSpec(spec);
    expect(r.operations.map((o) => o.success)).toEqual([{ field: "header.rsResponseCode", equals: "00" }, { field: "ResponseCode", equals: "00" }]);
  });
  it("finds nothing in text without Method lines", () => {
    expect(operationsFromSpec("accountNo M String 16 Account").operations).toEqual([]);
  });
});

describe("tables as banks really lay them out", () => {
  const table = [
    "Field                                      Data Type        Description",
    "responseSearch                             Object",
    "    1.  bankCode                           String           Participant",
    "    2.  sendTransaction                    Object",
    "        i.  totalWithdrawalVol             Numeric          Count",
    "                                                            Format: Long",
    "        ii. totalWithdrawalAmt             Numeric          Amount",
    "        iii.totalCreditTransferWithP       Numeric          Count with",
    "            roxyVol                                         proxy.",
    "        iv.     totalCreditTransferWi      Numeric          Amount with",
    "            thProxyAmt                                      proxy.",
    "    3.  receiveTransaction                 Object",
    "        i.  totalTopupVol                  Numeric          Count",
    "footer                                     String           After the groups",
  ].join("\n");
  it("roman numbering, no space after the dot, three levels, and a name wrapped onto the next line", () => {
    expect(fieldsFromTable(table).fields).toMatchObject([
      { name: "responseSearch", type: "object", required: false, children: [
        { name: "bankCode", type: "string", required: false },
        { name: "sendTransaction", type: "object", required: false, children: [
          { name: "totalWithdrawalVol", type: "numeric", required: false },
          { name: "totalWithdrawalAmt", type: "numeric", required: false },
          { name: "totalCreditTransferWithProxyVol", type: "numeric", required: false },
          { name: "totalCreditTransferWithProxyAmt", type: "numeric", required: false },
        ] },
        { name: "receiveTransaction", type: "object", required: false, children: [{ name: "totalTopupVol", type: "numeric", required: false }] },
      ] },
      { name: "footer", type: "string", required: false },
    ]);
  });
  it("a name cut short in the table is completed from the sample JSON beside it", () => {
    const cut = "detail Object\n1. totalCreditTransferWithP Numeric Count\n2. bankCode String Code";
    const sample = { detail: { totalCreditTransferWithProxyVol: 1, bankCode: "X" } };
    expect(completeNames(fieldsFromTable(cut).fields, sample)).toMatchObject([
      { name: "detail", type: "object", required: false, children: [
        { name: "totalCreditTransferWithProxyVol", type: "numeric", required: false }, { name: "bankCode", type: "string", required: false },
      ] },
    ]);
  });
});

describe("values the system fills (auto generated)", () => {
  it("keeps each row's description, wrapped lines joined", () => {
    const t = [
      "Field                                      Data Type         Description",
      "rqMsgId                                    String            System generated message id. Format:",
      "                                                             yyyyMMdd + sequence number",
      "rqMsgDate                                  String            Request message date time. Format:",
      "                                                             dd/MM/yyyy HH:mm:ss",
      "accountNo                                  String            Account to read",
    ].join("\n");
    expect(fieldsFromTable(t).fields.map((f) => f.description)).toEqual([
      "System generated message id. Format: yyyyMMdd + sequence number", "Request message date time. Format: dd/MM/yyyy HH:mm:ss", "Account to read",
    ]);
  });
  it("suggests auto values from what the spec says of a request field", () => {
    const fields = [
      { name: "header", type: "object" as const, required: false, children: [
        { name: "rqMsgId", type: "string" as const, required: true, description: "System generated message id. Format: yyyyMMdd + sequence number (12 digits)" },
        { name: "rqMsgDate", type: "string" as const, required: true, description: "Request message date time. Format: dd/MM/yyyy HH:mm:ss" },
        { name: "trxDate", type: "string" as const, required: true, description: "Tanggal transaksi, diisi otomatis. Format: yyyy-MM-dd" },
      ] },
      { name: "accountNo", type: "string" as const, required: true, description: "Account to read" },
    ];
    expect(suggestAuto(fields)).toEqual({
      "header.rqMsgId": { kind: "external_id" },
      "header.rqMsgDate": { kind: "now", format: "dd/MM/yyyy HH:mm:ss" },
      "header.trxDate": { kind: "now", format: "yyyy-MM-dd" },
    });
  });
  it("formats the current time in Asia/Jakarta", () => {
    const at = new Date("2026-11-22T03:04:05.678Z");
    expect(formatNow("dd/MM/yyyy HH:mm:ss", at)).toBe("22/11/2026 10:04:05");
    expect(formatNow("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", at)).toBe("2026-11-22T10:04:05.678+07:00");
    expect(formatNow("yyyyMMdd", at)).toBe("20261122");
  });
  it("fills auto values over what the body has, inside groups too, and says what it filled", () => {
    const r = withAuto({ header: { rqMsgId: "typed" }, a: 1 }, { "header.rqMsgId": { kind: "external_id" }, "header.rqMsgDate": { kind: "now", format: "yyyyMMdd" } }, { externalId: "20261122000000000007", now: new Date("2026-11-22T03:00:00Z") });
    expect(r).toEqual({ body: { header: { rqMsgId: "20261122000000000007", rqMsgDate: "20261122" }, a: 1 }, filled: { "header.rqMsgId": "20261122000000000007", "header.rqMsgDate": "20261122" } });
  });
});

describe("auto values in the contract", () => {
  const env = { baseUrl: "", host: "", partnerId: "", channelId: "" };
  const op = { key: "a", name: "A", method: "POST", path: "/", timeoutMs: 30000, request: [{ name: "rqMsgId", type: "string", required: true, description: "System generated" }, { name: "cur", type: "string", required: false }], response: [], success: null, reference: null, masked: [], presets: {} };
  const spec = (o: object) => ({ name: "X", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [{ ...op, ...o }] });
  it("an operation saved before auto values reads as none; a request field may be auto", () => {
    expect(ConnectorSpec.parse(spec({})).operations[0]!.auto).toEqual({});
    expect(ConnectorSpec.safeParse(spec({ auto: { rqMsgId: { kind: "external_id" } } })).success).toBe(true);
  });
  it("refuses an auto value on a field the request doesn't have, or on one with a fixed value", () => {
    const issue = (o: object) => ConnectorSpec.safeParse(spec(o)).error?.issues.map((i) => i.message);
    expect(issue({ auto: { nope: { kind: "external_id" } } })).toContain("An auto value is for a request field.");
    expect(issue({ presets: { cur: "IDR" }, auto: { cur: { kind: "now", format: "yyyy" } } })).toContain("A field is either fixed or auto, not both.");
  });
  it("a whole spec suggests auto values for its request fields", () => {
    const r = operationsFromSpec("1. Ping\nMethod POST\nPath /p\nRequest\nrqMsgId M String 20 System generated. Format: yyyyMMdd + sequence\nnote O String 10 Note");
    expect(r.operations[0]!.auto).toEqual({ rqMsgId: { kind: "external_id" } });
  });
});
