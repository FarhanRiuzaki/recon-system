import { describe, expect, it } from "vitest";
import { pathOf } from "./flow-parts";

const e = (source: string, target: string) => ({ id: `${source}>${target}`, source, target });
// src-a → side-a → p0 → p1 → out ; src-b → side-b → p0 ; p0 → matched
const edges = [e("src-a", "side-a"), e("src-b", "side-b"), e("side-a", "p0"), e("side-b", "p0"), e("p0", "p1"), e("p0", "matched"), e("p1", "out")];

describe("pathOf: what a hovered node lights", () => {
  it("everything upstream and downstream of it, and the edges between; nothing hovered = null", () => {
    const side = pathOf("side-a", edges)!;
    expect([...side.nodes].sort()).toEqual(["matched", "out", "p0", "p1", "side-a", "src-a"]);
    expect(side.edges.has("side-b>p0")).toBe(false);
    expect([...pathOf("p1", edges)!.nodes].sort()).toEqual(["out", "p0", "p1", "side-a", "side-b", "src-a", "src-b"]);
    expect(pathOf(null, edges)).toBeNull();
  });
});
