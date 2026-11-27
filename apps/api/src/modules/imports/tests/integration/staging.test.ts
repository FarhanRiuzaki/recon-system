import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { ApiError } from "../../../../kernel/errors";
import { history } from "../../staging/history-table";
import { NOT_SET_UP, staging, stagingForJobs, stagingNames, stagingSet, stagingUrlOrThrow } from "../../staging/pool";
import { historyRow, resetStaging, STAGING_SCHEMA } from "../../../../../test/helpers/staging";

beforeEach(resetStaging);

describe("the staging database", () => {
  it("is configured for the tests: <test database>_staging, schema imports_staging, no readonly grant", () => {
    expect(stagingSet()).toBe(true);
    expect(stagingNames()).toEqual({ schema: STAGING_SCHEMA, history: "import_file_history", readonlyRole: null });
    expect(process.env.STAGING_DATABASE_URL).toMatch(/_staging$/);
  });

  it("reads import-host's history rows through the Drizzle table, from the API's and the worker's pool", async () => {
    const id = await historyRow({ source: "KAI_TLHIST", date: "2026-11-03", status: "IMPORTED", rows: 2, inserted: 2 });
    for (const db of [staging(), stagingForJobs()]) {
      const rows = await db.select({ id: history().id, fileName: history().fileName, status: history().status, fileDate: history().fileDate })
        .from(history()).where(eq(history().source, "KAI_TLHIST"));
      expect(rows).toEqual([{ id, fileName: "HISTORY_TLHIST:2026-11-03", status: "IMPORTED", fileDate: "2026-11-03" }]);
    }
  });

  it("runs each statement on the API pool with a 5 s timeout", async () => {
    const [r] = (await staging().execute("show statement_timeout")) as unknown as { statement_timeout: string }[];
    expect(r!.statement_timeout).toBe("5s");
  });

  it("without STAGING_DATABASE_URL every caller gets the 409 the Import pages show", () => {
    const e = (() => { try { stagingUrlOrThrow({}); } catch (x) { return x; } })() as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect([e.code, e.status, e.message]).toEqual(["invalid_state", 409, NOT_SET_UP]);
  });
});
