import { describe, expect, it } from "vitest";
import { holdLeaving, leaveHeld } from "./use-leave-guard";

describe("navigations made in code wait for a form with unsaved edits (source wizard P1)", () => {
  it("held while a guard holds them, with the place they pointed; free again once it lets go", () => {
    expect(leaveHeld("/recons")).toBe(false);
    const asked: string[] = [];
    const release = holdLeaving((href) => asked.push(href));
    expect(leaveHeld("/recons")).toBe(true);
    expect(asked).toEqual(["/recons"]);
    release();
    expect(leaveHeld("/sources")).toBe(false);
  });
  it("an older guard's release leaves a newer hold in place", () => {
    const first = holdLeaving(() => {});
    const second = holdLeaving(() => {});
    first();
    expect(leaveHeld("/x")).toBe(true);
    second();
    expect(leaveHeld("/x")).toBe(false);
  });
});
