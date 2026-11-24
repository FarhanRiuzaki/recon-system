// The connector over a driver (connectors/index.ts) without a server: a keyset pull whose cursor does not move stops
// with a clear error instead of looping, and `within` answers by its deadline even when close() hangs.
import { describe, expect, it } from "bun:test";
import { type Connector, connectorFor, connectorOver, type Driver, retryingConnect, within } from "../../connectors";
import { ConnectorError } from "../../connectors/errors";

const never = () => new Promise<never>(() => {});

describe("pullWatermark over a driver whose cursor does not move", () => {
  it("stops with a spec error when a page ends on the cursor it started after", async () => {
    let pages = 0;
    const drv: Driver = {
      rows: async (sql) => (sql.includes("pg_attribute")
        ? [{ name: "w", type: "timestamp without time zone", nullable: "NO" }, { name: "id", type: "bigint", nullable: "NO" }]
        : (pages++, ["0", "1", "2"].map((id) => ({ w: "2026-11-19T00:00:00.003333", id })))),
      describe: never, stream: async function* () {}, close: async () => {},
    };
    const c = connectorOver("postgres", drv, { connectS: 1, statementS: 1 });
    const got = await (async () => {
      for await (const _ of c.pullWatermark({ from: { table: "t" }, columns: [], watermark: { column: "w", id_columns: ["id"] }, after: null, lookback: { seconds: 0 }, chunk: 2 })) { /* consume */ }
    })().catch((e) => e);
    expect(got).toBeInstanceOf(ConnectorError);
    expect([(got as ConnectorError).kind, (got as ConnectorError).message]).toEqual(["spec",
      'The pull did not move past watermark 2026-11-19T00:00:00.003333 and id 1: the source compares "w" or "id" differently from its own text. Use another watermark or id column.']);
    expect(pages).toBe(2);
  });

  it("composite ids: stops when the watermark and every id end where the page started", async () => {
    const drv: Driver = {
      rows: async (sql) => (sql.includes("pg_attribute")
        ? [{ name: "w", type: "date", nullable: "NO" }, { name: "b", type: "text", nullable: "NO" }, { name: "s", type: "int", nullable: "NO" }]
        : ["6", "7", "8"].map((s) => ({ w: "2026-11-19", b: "B1", s }))),
      describe: never, stream: async function* () {}, close: async () => {},
    };
    const got = await (async () => {
      for await (const _ of connectorOver("postgres", drv, { connectS: 1, statementS: 1 }).pullWatermark({ from: { table: "t" }, columns: [], watermark: { column: "w", id_columns: ["b", "s"] }, after: null, lookback: {}, chunk: 2 })) { /* consume */ }
    })().catch((e) => e);
    expect((got as ConnectorError).message).toBe('The pull did not move past watermark 2026-11-19 and ids B1, 7: the source compares "w" or "b", "s" differently from its own text. Use another watermark or id column.');
  });
});

describe("pullWatermark over a driver that answers a NULL id", () => {
  it("raises a spec error naming the column before the page is given out, so no cursor holds a null", async () => {
    const drv: Driver = {
      rows: async (sql) => (sql.includes("pg_attribute")
        ? [{ name: "w", type: "date", nullable: "NO" }, { name: "id", type: "text", nullable: "NO" }]
        : [{ w: "2026-11-19", id: "a" }, { w: "2026-11-19", id: null }]),
      describe: never, stream: async function* () {}, close: async () => {},
    };
    const given: unknown[] = [];
    const got = await (async () => {
      for await (const page of connectorOver("postgres", drv, { connectS: 1, statementS: 1 }).pullWatermark({ from: { table: "t" }, columns: [], watermark: { column: "w", id_columns: ["id"] }, after: null, lookback: {}, chunk: 5 })) given.push(page);
    })().catch((e) => e);
    expect([(got as ConnectorError).kind, (got as ConnectorError).message]).toEqual(["spec",
      'Column "id" is empty (NULL) in a row of table t: a pull can\'t place that row after the last one it read, so it would be skipped. Fill "id" in every row, or pick a watermark and id columns that are never empty.']);
    expect(given).toEqual([]);
  });
});

describe("within", () => {
  const fake = (close: () => Promise<void>): Connector => ({ test: never, introspect: never, pullWatermark: never, pullSnapshot: never, sample: never, close } as unknown as Connector);

  it("answers when fn does, even when close() never returns", async () => {
    const t0 = performance.now();
    expect(await within(fake(never), 1, async () => "done")).toBe("done");
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("answers the timeout at the deadline, even when fn and close() both hang", async () => {
    const t0 = performance.now();
    const e = await within(fake(never), 0.2, never).catch((x) => x);
    expect([(e as ConnectorError).kind, (e as ConnectorError).message]).toEqual(["timeout", "The server did not answer within 0.2 s."]);
    expect(performance.now() - t0).toBeLessThan(700);
  });
});

describe("a PostgreSQL connector when a connect stalls", () => {
  it("retries once on a fresh connection inside the connect budget, then reports a timeout", async () => {
    let accepted = 0;
    const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { accepted++; }, data() {} } });
    const c = connectorFor("postgres", { host: "127.0.0.1", port: srv.port, database: "d", user: "u", password: "p" }, { tls: false, connectTimeoutSeconds: 5, statementTimeoutMs: 5000 });
    const t0 = Date.now();
    const got = await c.test().catch((e) => e);
    const ms = Date.now() - t0;
    await c.close();
    srv.stop(true);
    expect([got.code, got.seconds]).toEqual(["ERR_POSTGRES_CONNECTION_TIMEOUT", 4]);
    expect(accepted).toBe(2); // two attempts of 2 s (40 % of 5 s)
    expect(ms).toBeGreaterThanOrEqual(3900);
    expect(ms).toBeLessThan(5000);
  }, 10000);
});

describe("retryingConnect over a fake non-PostgreSQL driver", () => {
  const t = { connectS: 5, statementS: 5 };
  const stall = (code: string, ms: number): Driver => ({
    rows: () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("x"), { code })), ms)),
    describe: never, stream: async function* () {}, close: async () => {},
  });
  it("starts over once on a connect timeout and reports the time spent in all", async () => {
    let made = 0;
    const c = connectorOver("oracle", retryingConnect(() => (made++, stall("NJS-510", 1100)), t), t);
    const got = await c.test().catch((e) => e);
    expect([got.kind, got.code, got.seconds, made]).toEqual(["timeout", "NJS-510", 2, 2]);
    expect(got.message).toBe("The server did not answer within 2 s.");
  });
  it("does not retry a refusal", async () => {
    let made = 0;
    const got = await retryingConnect(() => (made++, stall("ORA-12541", 0)), t).rows("x", []).catch((e) => e);
    expect([got.kind, made]).toEqual(["host", 1]);
  });
  it("recovers when the second attempt answers", async () => {
    let made = 0;
    const ok: Driver = { rows: async () => [{ one: 1 }], describe: never, stream: async function* () {}, close: async () => {} };
    const d = retryingConnect(() => (made++ ? ok : stall("ETIMEDOUT", 0)), t);
    expect(await d.rows("x", [])).toEqual([{ one: 1 }]);
  });
});
