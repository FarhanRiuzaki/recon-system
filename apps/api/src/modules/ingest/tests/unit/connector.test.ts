// The connector over a driver (connectors/index.ts) without a server: a keyset pull whose cursor does not move stops
// with a clear error instead of looping, and `within` answers by its deadline even when close() hangs.
import { describe, expect, it } from "bun:test";
import { type Connector, connectorOver, type Driver, within } from "../../connectors";
import { ConnectorError } from "../../connectors/errors";

const never = () => new Promise<never>(() => {});

describe("pullWatermark over a driver whose cursor does not move", () => {
  it("stops with a spec error when a page ends on the cursor it started after", async () => {
    let pages = 0;
    const drv: Driver = {
      rows: async (sql) => (sql.includes("pg_attribute")
        ? [{ name: "w", type: "timestamp without time zone", nullable: "NO" }, { name: "id", type: "bigint", nullable: "NO" }]
        : (pages++, [{ w: "2026-11-19T00:00:00.003333", id: "1" }, { w: "2026-11-19T00:00:00.003333", id: "1" }])),
      describe: never, stream: async function* () {}, close: async () => {},
    };
    const c = connectorOver("postgres", drv, { connectS: 1, statementS: 1 });
    const got = await (async () => {
      for await (const _ of c.pullWatermark({ from: { table: "t" }, columns: [], watermark: { column: "w", id_column: "id" }, after: null, lookbackSeconds: 0, chunk: 2 })) { /* consume */ }
    })().catch((e) => e);
    expect(got).toBeInstanceOf(ConnectorError);
    expect([(got as ConnectorError).kind, (got as ConnectorError).message]).toEqual(["spec",
      'The pull did not move past watermark 2026-11-19T00:00:00.003333 and id 1: the source compares "w" or "id" differently from its own text. Use another watermark or id column.']);
    expect(pages).toBe(2);
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
