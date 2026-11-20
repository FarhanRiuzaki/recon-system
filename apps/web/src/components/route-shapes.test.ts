import { describe, expect, it } from "vitest";
import { RECON_SHAPE, RECONS_SHAPE } from "@/features/recon/shapes";
import { SOURCE_DETAIL_SHAPE, SOURCES_SHAPE, WIZARD_SHAPE } from "@/features/sources/shapes";
import { shapeOfPath } from "./route-shapes";

describe("shapeOfPath", () => {
  it("finds a space page's shape by its path; a literal segment wins over a dynamic one", () => {
    expect(shapeOfPath("/spaces/abc/sources")).toBe(SOURCES_SHAPE);
    expect(shapeOfPath("/spaces/abc/sources/new")).toBe(WIZARD_SHAPE);
    expect(shapeOfPath("/spaces/abc/sources/s1")).toBe(SOURCE_DETAIL_SHAPE);
    expect(shapeOfPath("/spaces/abc/recons/c1/")).toBe(RECON_SHAPE);
    expect(shapeOfPath("/recons")).toBe(RECONS_SHAPE);
  });
  it("is null for a page not listed", () => {
    expect(shapeOfPath("/users")).toBeNull();
    expect(shapeOfPath("/spaces/abc")).toBeNull();
    expect(shapeOfPath("/spaces/abc/sources/s1/files")).toBeNull();
  });
});
