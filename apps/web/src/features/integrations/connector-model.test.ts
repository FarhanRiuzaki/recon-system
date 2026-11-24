import { describe, expect, it } from "vitest";
import type { ConnectorSpec, OperationSpec } from "@starterkit/shared/contracts/integrations";
import { CALLS_GO_TO, callsGoTo, mergeSpecOperations, prune, renamePath, replaceAt, specChanges, turnOffSentence } from "./connector-model";

const op: OperationSpec = {
  key: "post", name: "Post", method: "POST", path: "/", timeoutMs: 30000,
  request: [{ name: "Currency", type: "string", required: false }, { name: "DE48", type: "object", required: false, children: [{ name: "Cur", type: "string", required: false }] }],
  response: [{ name: "ResponseCode", type: "string", required: false }, { name: "Ref", type: "string", required: false }],
  success: { field: "ResponseCode", equals: "00" }, reference: "Ref", masked: ["DE48.Cur", "Ref"], presets: { Currency: "IDR", "DE48.Cur": "IDR" }, auto: {},
};

describe("a connector's draft (final review I2, I3)", () => {
  it("renaming a field moves its fixed value, mask, success rule and reference with it, children included", () => {
    const r = renamePath(op, "DE48", "DE49");
    expect(r.presets).toEqual({ Currency: "IDR", "DE49.Cur": "IDR" });
    expect(r.masked).toEqual(["DE49.Cur", "Ref"]);
    const s = renamePath(op, "ResponseCode", "RC");
    expect([s.success?.field, renamePath(op, "Ref", "BankRef").reference]).toEqual(["RC", "BankRef"]);
  });
  it("saving drops what points to a field that is gone, so the draft still saves", () => {
    const gone = prune({ ...op, request: [op.request[0]!], response: [op.response[0]!] });
    expect([gone.presets, gone.masked, gone.reference, gone.success?.field]).toEqual([{ Currency: "IDR" }, [], null, "ResponseCode"]);
    expect(prune({ ...op, response: [] }).success).toBeNull();
  });
  it("an operation is replaced by its place, never by its key, so two with the same key stay two", () => {
    const a = { ...op, key: "same" }, b = { ...op, key: "same", name: "Second" };
    expect(replaceAt([a, b], 1, { ...b, name: "Edited" }).map((o) => o.name)).toEqual(["Post", "Edited"]);
  });
});

describe("operations pasted from a whole spec", () => {
  const env = { baseUrl: "", host: "", partnerId: "P1", channelId: "C1", verifyTls: false };
  const spec: ConnectorSpec = { name: "Bank", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [{ ...op, key: "fund_status", timeoutMs: 15000, presets: { Currency: "IDR" } }] };
  const pasted = {
    baseUrl: "https://api.bank.local:15000",
    operations: [
      { key: "fund_status", name: "Fund Status", method: "GET" as const, path: "/openapi/fund", request: [{ name: "Currency", type: "string" as const, required: false }], response: [], success: null, auto: {} },
      { key: "balance", name: "Balance", method: "POST" as const, path: "/openapi/balance", request: [], response: [{ name: "rsResponseCode", type: "string" as const, required: false }], success: { field: "rsResponseCode", equals: "00" }, auto: {} },
    ],
  };
  it("updates an operation of the same key (keeping its time limit and what still applies) and adds the new ones", () => {
    const r = mergeSpecOperations(spec, pasted, true);
    expect([r.added, r.updated, r.skipped]).toEqual([1, 1, 0]);
    expect(r.spec.operations.map((o) => [o.key, o.method, o.path, o.timeoutMs])).toEqual([["fund_status", "GET", "/openapi/fund", 15000], ["balance", "POST", "/openapi/balance", 30000]]);
    expect(r.spec.operations[0]!.presets).toEqual({ Currency: "IDR" });
    expect(r.spec.operations[1]!.success).toEqual({ field: "rsResponseCode", equals: "00" });
  });
  it("fills the development address and Host only while they are empty, and only when asked", () => {
    expect(mergeSpecOperations(spec, pasted, true).spec.environments.dev).toMatchObject({ baseUrl: "https://api.bank.local:15000", host: "api.bank.local" });
    expect(mergeSpecOperations(spec, pasted, false).spec.environments.dev.baseUrl).toBe("");
    const set = { ...spec, environments: { ...spec.environments, dev: { ...env, baseUrl: "https://other.local" } } };
    expect(mergeSpecOperations(set, pasted, true).spec.environments.dev.baseUrl).toBe("https://other.local");
  });
  it("stops at the operations limit and counts the rest as skipped", () => {
    const many = { baseUrl: null, operations: Array.from({ length: 60 }, (_, i) => ({ ...pasted.operations[1]!, key: `op_${i}` })) };
    const r = mergeSpecOperations({ ...spec, operations: [] }, many, false);
    expect([r.spec.operations.length, r.added, r.skipped]).toEqual([50, 50, 10]);
  });
});

describe("auto values in the draft", () => {
  const withAuto: OperationSpec = { ...op, auto: { "DE48.Cur": { kind: "now", format: "yyyy" } }, presets: { Currency: "IDR" } };
  // (presets drop DE48.Cur: a field is fixed or auto, not both)
  it("move with a renamed field and go with a removed one", () => {
    expect(renamePath(withAuto, "DE48", "DE49").auto).toEqual({ "DE49.Cur": { kind: "now", format: "yyyy" } });
    expect(prune({ ...withAuto, request: [withAuto.request[0]!] }).auto).toEqual({});
  });
  it("a pasted spec brings its suggested auto values; an existing operation keeps the ones it set", () => {
    const env = { baseUrl: "", host: "", partnerId: "", channelId: "", verifyTls: false };
    const spec: ConnectorSpec = { name: "B", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [{ ...withAuto, key: "same" }] };
    const field = { name: "rqMsgId", type: "string" as const, required: true };
    const r = mergeSpecOperations(spec, { baseUrl: null, operations: [
      { key: "same", name: "S", method: "POST", path: "/s", request: [...withAuto.request, field], response: [], success: null, auto: { rqMsgId: { kind: "external_id" }, "DE48.Cur": { kind: "external_id" } } },
      { key: "new", name: "N", method: "POST", path: "/n", request: [field], response: [], success: null, auto: { rqMsgId: { kind: "external_id" } } },
    ] }, false);
    expect(r.spec.operations.map((o) => o.auto)).toEqual([
      { rqMsgId: { kind: "external_id" }, "DE48.Cur": { kind: "now", format: "yyyy" } },
      { rqMsgId: { kind: "external_id" } },
    ]);
  });
});

describe("Turn off connector (audit C2): says how many recons use it", () => {
  it("one recon, many, none", () => {
    expect(turnOffSentence(1)).toBe("Used by 1 recon: what it would send through it is marked not sent until it is on again.");
    expect(turnOffSentence(3)).toBe("Used by 3 recons: what they would send through it is marked not sent until it is on again.");
    expect(turnOffSentence(0)).toBe("No recon uses it: nothing is sent through it until it is on again.");
  });
});

describe("a version under review against the live one (maker-checker)", () => {
  const env = { baseUrl: "https://a.local", host: "", partnerId: "P1", channelId: "C1", verifyTls: false };
  const live: ConnectorSpec = { name: "Bank", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [op, { ...op, key: "other" }] };
  it("marks the name, where calls go, each environment and each operation that differs; nothing against no live version", () => {
    expect(specChanges(live, live)).toEqual({ name: false, active: false, environments: { dev: false, prod: false }, operations: [false, false], removed: [] });
    const next: ConnectorSpec = { ...live, name: "Bank 2", active: "prod", environments: { ...live.environments, prod: { ...env, partnerId: "P2" } }, operations: [{ ...op, path: "/v2" }, { ...op, key: "new" }] };
    expect(specChanges(live, next)).toEqual({ name: true, active: true, environments: { dev: false, prod: true }, operations: [true, true], removed: ["Post"] });
    expect(specChanges(null, next)).toBeNull();
  });
  it("where calls go reads the same on the field and on the environment's card", () => {
    expect(CALLS_GO_TO).toBe("Calls go to");
    expect(callsGoTo("dev")).toBe("Calls go to Development");
  });
});
