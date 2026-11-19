// spaces and space_members: the keys and checks of the tables, and spaceRolesOf.
import { beforeEach, describe, expect, it } from "bun:test";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { resetData } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { users } from "../../../users";
import { spaceMembers, spaces } from "../../schema";
import { spaceRolesOf } from "../../service";

const errno = (e: unknown) => ((e as { cause?: { errno?: string } }).cause ?? (e as { errno?: string })).errno;
const S = Bun.randomUUIDv7();
let u1: string, u2: string;

beforeEach(async () => {
  await resetData();
  [u1, u2] = (await db.select({ id: users.id }).from(users).limit(2)).map((u) => u.id) as [string, string];
  await db.insert(spaces).values({ id: S, code: "treasury", name: "Treasury" });
});

describe("spaces tables", () => {
  it("a code is unique ignoring letter case", async () => {
    const e = await db.insert(spaces).values({ id: Bun.randomUUIDv7(), code: "Treasury", name: "Other" }).catch((e: unknown) => e);
    expect(errno(e)).toBe("23505");
  });

  it("a member row takes each of the seven roles and nothing else", async () => {
    await db.insert(spaceMembers).values(SPACE_ROLES.map((role) => ({ spaceId: S, userId: u1, role })));
    const e = await db.insert(spaceMembers).values({ spaceId: S, userId: u2, role: "admin" }).catch((e: unknown) => e);
    expect(errno(e)).toBe("23514");
  });
});

describe("spaceRolesOf", () => {
  it("every role the user holds in that space, in SPACE_ROLES order; [] for a non-member or another space", async () => {
    const other = Bun.randomUUIDv7();
    await db.insert(spaces).values({ id: other, code: "ctop", name: "CTOP" });
    await db.insert(spaceMembers).values([
      { spaceId: S, userId: u1, role: "viewer" }, { spaceId: S, userId: u1, role: "operator" }, { spaceId: S, userId: u1, role: "config_maker" },
      { spaceId: other, userId: u2, role: "space_admin" },
    ]);
    expect(await db.transaction((tx) => spaceRolesOf(tx, u1, S))).toEqual(["config_maker", "operator", "viewer"]);
    expect(await db.transaction((tx) => spaceRolesOf(tx, u2, S))).toEqual([]);
    expect(await db.transaction((tx) => spaceRolesOf(tx, u1, other))).toEqual([]);
  });
});
