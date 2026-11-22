import { describe, expect, it } from "vitest";
import { currentSpace, switchHref } from "./space-switcher";

const A = "0199f0a0-0000-7000-8000-00000000000a";
const B = "0199f0a0-0000-7000-8000-00000000000b";

describe("switchHref: where switching to another space goes", () => {
  it("the same page under the new space when that page exists there", () => {
    expect(switchHref(`/spaces/${A}/members`, B)).toBe(`/spaces/${B}/members`);
    expect(switchHref(`/spaces/${A}/members/`, B)).toBe(`/spaces/${B}/members`);
  });
  it("members when the page doesn't exist in a space, or the page is outside any space", () => {
    expect(switchHref(`/spaces/${A}/reports/x`, B)).toBe(`/spaces/${B}/members`);
    expect(switchHref(`/spaces/${A}`, B)).toBe(`/spaces/${B}/members`);
    expect(switchHref("/users", B)).toBe(`/spaces/${B}/members`);
    expect(switchHref("/spaces", B)).toBe(`/spaces/${B}/members`);
  });
});

describe("currentSpace: the space the switcher shows", () => {
  const items = [{ id: A }, { id: B }];
  it("the space in the URL, else the remembered one, else the first", () => {
    expect(currentSpace(items, `/spaces/${B}/members`, A)?.id).toBe(B);
    expect(currentSpace(items, "/users", B)?.id).toBe(B);
    expect(currentSpace(items, "/users", null)?.id).toBe(A);
    expect(currentSpace(items, "/users", "0199f0a0-0000-7000-8000-0000000000ff")?.id).toBe(A);
    expect(currentSpace([], "/users", A)).toBeUndefined();
  });
  it("with nothing remembered, the first space the caller holds a role in, not one they only view", () => {
    expect(currentSpace([{ id: A, roles: [] }, { id: B, roles: ["config_maker"] }], "/users", null)?.id).toBe(B);
    expect(currentSpace([{ id: A, roles: [] }, { id: B, roles: [] }], "/users", null)?.id).toBe(A);
  });
});
