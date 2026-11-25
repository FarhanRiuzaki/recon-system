import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { budget } from "./perf";

// every test file runs in one process: the factor this run was given is put back for the timing tests after this one
const given = process.env.TEST_PERF_FACTOR;
beforeEach(() => { delete process.env.TEST_PERF_FACTOR; });
afterEach(() => { if (given === undefined) delete process.env.TEST_PERF_FACTOR; else process.env.TEST_PERF_FACTOR = given; });
describe("budget", () => {
  it("is the written budget unless TEST_PERF_FACTOR widens it; a factor under 1 or not a number changes nothing", () => {
    expect(budget(2000)).toBe(2000);
    process.env.TEST_PERF_FACTOR = "1.5"; expect(budget(2000)).toBe(3000);
    process.env.TEST_PERF_FACTOR = "0.5"; expect(budget(2000)).toBe(2000);
    process.env.TEST_PERF_FACTOR = "x"; expect(budget(2000)).toBe(2000);
  });
});
