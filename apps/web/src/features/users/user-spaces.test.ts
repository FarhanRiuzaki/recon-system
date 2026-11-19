import { describe, expect, it } from "vitest";
import type { Page } from "@starterkit/shared/contracts/common";
import type { UserSpaceDto } from "@starterkit/shared/contracts/spaces";
import { joinedSpaces } from "./user-spaces";

const row = (spaceId: string): UserSpaceDto => ({ spaceId, code: spaceId, name: spaceId, status: "active", roles: ["viewer"] });
const page = (items: UserSpaceDto[], total = items.length, totalCapped?: boolean): Page<UserSpaceDto> =>
  ({ items, total, page: 1, pageSize: 100, ...(totalCapped ? { totalCapped } : {}) });

describe("joinedSpaces: the user's spaces only when the whole list is loaded (else Add to space is hidden)", () => {
  it("the ids when every space is on the page, [] for a user in none", () => {
    expect(joinedSpaces(page([row("a"), row("b")]))).toEqual(["a", "b"]);
    expect(joinedSpaces(page([]))).toEqual([]);
  });

  it("null while pending or failed (no data), and when the user is in more spaces than the page holds", () => {
    expect(joinedSpaces(undefined)).toBeNull();
    expect(joinedSpaces(page([row("a")], 101))).toBeNull();
    expect(joinedSpaces(page([row("a")], 100_000, true))).toBeNull();
  });
});
