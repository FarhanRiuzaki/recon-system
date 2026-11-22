import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import path from "node:path";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SourceDto, SourceFileDto, SourceRowDto, SourceSnapshotDto } from "@starterkit/shared/contracts/sources";
import { PERMISSIONS } from "@starterkit/shared/permissions";
import { seedDemo } from "../../src/db/seed/demo";
import { LOCAL_ROLES, PEOPLE_ROLES, seedLocal } from "../../src/db/seed/local";
import { seedSystem } from "../../src/db/seed/system";
import { decryptSecret } from "../../src/kernel/crypto";
import { and, asc, count, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../../src/kernel/db";
import { log } from "../../src/kernel/log";
import { activity, authLog } from "../../src/modules/audit";
import { rolesOf, verifyPassword } from "../../src/modules/auth";
import { userIdentities } from "../../src/modules/oauth";
import { permissions, rolePermissions, roles, userRoles } from "../../src/modules/rbac";
import { spaceMembers, spaces } from "../../src/modules/spaces";
import { recoveryCodes, users } from "../../src/modules/users";
import { call, signIn } from "../helpers/app";
import { truncateAll } from "../helpers/db";

// Explicit env: never the SEED_SUPERADMIN_* values bun test loads from apps/api/.env.
const OWNER = { SEED_SUPERADMIN_NAME: "Seed Owner", SEED_SUPERADMIN_EMAIL: "Owner@Example.test", SEED_SUPERADMIN_USERNAME: "owner", SEED_SUPERADMIN_PASSWORD: "Owner-Password-1!" };

/** Every user with its role names. */
const usersWithRoles = () => db.select({ u: users, roles: rolesOf(users.id) }).from(users).orderBy(users.email).then((rs) => rs.map((r) => ({ ...r.u, roles: r.roles })));
const userCount = async () => (await db.select({ n: count() }).from(users))[0]!.n;

const snapshot = async () => ({
  permissions: await db.select().from(permissions).orderBy(permissions.position),
  roles: await db.select({
    name: roles.name, locked: roles.locked, createdAt: roles.createdAt,
    perms: sql<string[]>`array(${db.select({ p: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, roles.id)).orderBy(rolePermissions.permission)})`,
  }).from(roles).orderBy(roles.name),
  users: await usersWithRoles(),
});

beforeEach(truncateAll);

describe("seedSystem", () => {
  it("the role seeder adds Maker and Approver; the user seeder adds the default maker and approver only with their password keys, once", async () => {
    await seedSystem(db, {});
    expect((await db.select({ name: roles.name }).from(roles).orderBy(roles.name)).map((r) => r.name)).toEqual(["Admin", "Approver", "Maker", "Superadmin", "Viewer"]);
    expect(await userCount()).toBe(0);
    const env = { SEED_MAKER_PASSWORD: "Maker-Password-1!", SEED_APPROVER_PASSWORD: "Approver-Password-1!" };
    await seedSystem(db, env);
    await seedSystem(db, env);
    expect((await usersWithRoles()).map((u) => [u.username, u.roles])).toEqual([["approver", ["Approver"]], ["maker", ["Maker"]]]);
    expect(await signIn("maker", "Maker-Password-1!").then(() => true, () => false)).toBe(true);
    expect(await signIn("approver", "Approver-Password-1!").then(() => true, () => false)).toBe(true);
    const short = await seedSystem(db, { NODE_ENV: "production", SEED_MAKER_PASSWORD: "short" }).catch((e: Error) => e.message);
    expect(short).toBe("SEED_MAKER_PASSWORD must be 12 to 128 characters in production.");
  });

  it("system seed twice changes nothing", async () => {
    await seedSystem(db, OWNER);
    const first = await snapshot();
    expect(first.permissions.map((p: { name: string }) => p.name)).toEqual([...PERMISSIONS]);
    expect(first.roles.map((r: { name: string; locked: boolean; perms: string[] }) => [r.name, r.locked, r.perms])).toEqual([
      // Admin: every permission but role.* and permission.*, so a new module's permissions come with it on a fresh install.
      ["Admin", false, PERMISSIONS.filter((p) => !p.startsWith("role.") && !p.startsWith("permission.")).sort()],
      ["Approver", false, ["audit.view", "user.view"]],
      ["Maker", false, ["audit.view", "user.view"]],
      ["Superadmin", true, [...PERMISSIONS].sort()],
      ["Viewer", false, ["audit.view", "user.view"]],
    ]);
    expect(first.users).toHaveLength(1);
    expect(first.users[0]).toMatchObject({ name: "Seed Owner", email: "Owner@Example.test", username: "owner", isActive: true, roles: ["Superadmin"] });
    expect(await verifyPassword("Owner-Password-1!", first.users[0]!.passwordHash)).toBe(true);
    await seedSystem(db, OWNER);
    expect(await snapshot()).toEqual(first);
  });

  it("bootstrap only: an active Superadmin there and a changed SEED_SUPERADMIN_EMAIL creates nobody and doesn't fail", async () => {
    await seedSystem(db, OWNER);
    const before = await usersWithRoles();
    const info = spyOn(log, "info");
    try {
      await seedSystem(db, { ...OWNER, SEED_SUPERADMIN_EMAIL: "new-owner@example.test" }); // same username, another email
      expect(info).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(info.mock.calls)).not.toContain("Owner-Password-1!");
      expect(JSON.stringify(info.mock.calls)).not.toContain("new-owner@example.test");
    } finally {
      info.mockRestore();
    }
    expect(await usersWithRoles()).toEqual(before);
  });

  it("bootstrap only: the seeded owner deleted while another active Superadmin exists creates nobody", async () => {
    await seedSystem(db, OWNER);
    const [superadmin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Superadmin"));
    const other = Bun.randomUUIDv7();
    await db.insert(users).values({ id: other, name: "Other", username: "other", email: "other@example.test" });
    await db.insert(userRoles).values({ userId: other, roleId: superadmin!.id });
    await db.delete(users).where(eq(users.username, "owner"));
    await seedSystem(db, OWNER);
    expect((await usersWithRoles()).map((u) => [u.username, u.roles])).toEqual([["other", ["Superadmin"]]]);
  });

  it("bootstrap only: an inactive Superadmin doesn't count; an empty install gets the owner", async () => {
    await seedSystem(db, {});
    const [superadmin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Superadmin"));
    const other = Bun.randomUUIDv7();
    await db.insert(users).values({ id: other, name: "Other", username: "other", email: "other@example.test", isActive: false });
    await db.insert(userRoles).values({ userId: other, roleId: superadmin!.id });
    await seedSystem(db, OWNER);
    expect((await usersWithRoles()).map((u) => [u.username, u.roles])).toEqual([["other", ["Superadmin"]], ["owner", ["Superadmin"]]]);
  });

  it("an existing user with the superadmin email keeps its password and roles", async () => {
    await seedSystem(db, {});
    expect(await userCount()).toBe(0);
    await db.insert(users).values({ id: Bun.randomUUIDv7(), name: "Someone", username: "someone", email: "owner@example.test", passwordHash: "kept" });
    await seedSystem(db, OWNER);
    const u = await db.select({ username: users.username, passwordHash: users.passwordHash }).from(users);
    expect(u).toEqual([{ username: "someone", passwordHash: "kept" }]);
    expect(await db.select().from(userRoles)).toEqual([]);
  });

  it("an unknown email whose username is taken fails naming the key", async () => {
    await db.insert(users).values({ id: Bun.randomUUIDv7(), name: "Someone", username: "OWNER", email: "someone@example.test" });
    const err = await seedSystem(db, OWNER).catch((e: unknown) => e);
    expect(String(err)).toContain("SEED_SUPERADMIN_USERNAME");
    expect(await userCount()).toBe(1);
  });

  it("password policy: production refuses a short password, elsewhere it is one warning", async () => {
    const short = { ...OWNER, SEED_SUPERADMIN_PASSWORD: "Sh0rt-pw!" };
    const err = await seedSystem(db, { ...short, NODE_ENV: "production" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain("Sh0rt-pw!");
    expect(await userCount()).toBe(0);
    const warn = spyOn(log, "warn");
    try {
      await seedSystem(db, { ...short, NODE_ENV: "development" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("Sh0rt-pw!");
    } finally {
      warn.mockRestore();
    }
    expect(await userCount()).toBe(1);
  });

  it("db:seed runs in production with only the database URL and SEED_SUPERADMIN_*, without the server's secrets", async () => {
    // --no-env-file: nothing from apps/api/.env; the env below is all the process gets (compose's migrate service).
    const r = Bun.spawnSync(["bun", "--no-env-file", "src/db/seed/cli.ts", "system"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH!, NODE_ENV: "production", DATABASE_URL: process.env.DATABASE_URL!, LOG_LEVEL: "silent", ...OWNER },
      stderr: "pipe",
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect((await usersWithRoles()).map((u) => [u.username, u.roles])).toEqual([["owner", ["Superadmin"]]]);
  });
});

describe("seedLocal", () => {
  beforeEach(async () => { await truncateAll(); });

  it("adds Treasury with the Superadmin as space admin, source admin and config maker, once however often it runs", async () => {
    await seedSystem(db, OWNER);
    await seedLocal(db, OWNER);
    await seedLocal(db, OWNER);
    const rows = await db.select({ code: spaces.code, role: spaceMembers.role, username: users.username }).from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId)).innerJoin(users, eq(users.id, spaceMembers.userId)).orderBy(spaceMembers.role);
    expect(rows).toEqual([...LOCAL_ROLES].sort().map((role) => ({ code: "treasury", role, username: "owner" })));
    expect((await db.select({ n: count() }).from(spaces))[0]!.n).toBe(1);
  });

  it("gives the default maker and approver their roles in Treasury, once; without them nobody else is added", async () => {
    await seedSystem(db, OWNER);
    await seedLocal(db, OWNER);
    expect((await db.select().from(users).where(or(eq(users.username, "maker"), eq(users.username, "approver")))).length).toBe(0);
    const env = { ...OWNER, SEED_MAKER_PASSWORD: "Maker-Password-1!", SEED_APPROVER_PASSWORD: "Approver-Password-1!" };
    await seedSystem(db, env);
    await seedLocal(db, env);
    await seedLocal(db, env);
    const rows = await db.select({ username: users.username, role: spaceMembers.role }).from(spaceMembers).innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(or(eq(users.username, "maker"), eq(users.username, "approver"))).orderBy(users.username, spaceMembers.role);
    expect(rows).toEqual([
      ...PEOPLE_ROLES.approver.map((role) => ({ username: "approver", role })),
      ...[...PEOPLE_ROLES.maker].sort().map((role) => ({ username: "maker", role })),
    ]);
  });

  it("refuses without SEED_SUPERADMIN_USERNAME or a user by that name", async () => {
    const none = await seedLocal(db, {}).catch((e: Error) => e.message);
    expect(none).toContain("SEED_SUPERADMIN_USERNAME");
    const missing = await seedLocal(db, { SEED_SUPERADMIN_USERNAME: "nobody" }).catch((e: Error) => e.message);
    expect(missing).toContain("names no user");
  });
});

describe("seedDemo", () => {
  it("demo accounts sign in with Password123!", async () => {
    await seedSystem(db, {});
    await seedDemo(db);
    const all = await usersWithRoles();
    const by = (k: string) => all.find((u) => u.username === k)!;
    for (const [k, role] of [["superadmin", "Superadmin"], ["admin", "Admin"], ["viewer", "Viewer"], ["twofa", "Admin"], ["inactive", "Viewer"], ["google", "Viewer"], ["apple", "Viewer"]]) {
      expect(by(k!)).toMatchObject({ email: `${k}@example.com`, roles: [role] });
      expect(await verifyPassword("Password123!", by(k!).passwordHash)).toBe(true);
    }
    expect(by("inactive")).toMatchObject({ isActive: false, lastLoginAt: null });
    expect(by("ldap")).toMatchObject({ isLdap: true, passwordHash: null, roles: ["Viewer"] });
    expect(decryptSecret(by("twofa").totpSecret!)).toBe("JBSWY3DPEHPK3PXP");
    const codes = await db.select({ codeHash: recoveryCodes.codeHash }).from(recoveryCodes).where(eq(recoveryCodes.userId, by("twofa").id));
    expect(codes).toHaveLength(8);
    for (const code of ["aaaa-1111", "hhhh-8888"]) {
      const hits = await Promise.all(codes.map((c) => verifyPassword(code, c.codeHash)));
      expect(hits.filter(Boolean)).toHaveLength(1);
    }
    const identities = db.select({ provider: userIdentities.provider, subject: userIdentities.subject, email: userIdentities.email }).from(userIdentities);
    expect(await identities.orderBy(asc(userIdentities.provider))).toEqual([
      { provider: "apple", subject: "mock-apple-demo", email: "apple@example.com" },
      { provider: "google", subject: "mock-google-demo", email: "google@example.com" },
    ]);
    const n = {
      users: await userCount(), activity: (await db.select({ n: count() }).from(activity))[0]!.n, auth: (await db.select({ n: count() }).from(authLog))[0]!.n,
    };
    expect(n).toEqual({ users: 50, activity: 200, auth: 300 });
    const [nulls] = await db.select({ n: count() }).from(activity).where(or(
      and(isNull(activity.before), eq(activity.action, "user.update")), and(isNotNull(activity.before), ne(activity.action, "user.update")),
      sql`jsonb_typeof(${activity.before}) = 'null'`,
    ));
    expect(nulls!.n).toBe(0); // only user.update entries have a before; the others are SQL NULL
  });

  it("demo spaces: Treasury, CTOP and FICO, each with a space admin; viewer in two of them, google in none", async () => {
    await seedSystem(db, {});
    await seedDemo(db);
    const rows = await db.select({ code: spaces.code, name: spaces.name, username: users.username, role: spaceMembers.role, active: users.isActive })
      .from(spaceMembers).innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId)).innerJoin(users, eq(users.id, spaceMembers.userId));
    expect((await db.select({ code: spaces.code, name: spaces.name }).from(spaces).orderBy(spaces.code)))
      .toEqual([{ code: "ctop", name: "CTOP" }, { code: "fico", name: "FICO" }, { code: "treasury", name: "Treasury" }]);
    for (const c of ["treasury", "ctop", "fico"]) {
      expect(rows.some((r) => r.code === c && r.role === "space_admin" && r.active)).toBe(true);
      const roles = new Map<string, number>();
      for (const r of rows.filter((x) => x.code === c)) roles.set(r.username, (roles.get(r.username) ?? 0) + 1);
      expect([...roles.values()].some((n) => n > 1)).toBe(true); // someone holds several roles
    }
    expect([...new Set(rows.filter((r) => r.username === "viewer").map((r) => r.code))].sort()).toEqual(["ctop", "treasury"]);
    expect(rows.filter((r) => r.username === "google")).toEqual([]);
  });

  it("demo sources: Treasury's nine (page 04 names) in every state the sources screens show; CTOP reads one through a share", async () => {
    await seedSystem(db, {});
    await seedDemo(db);
    const T = (await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.code, "treasury")))[0]!.id;
    const C = (await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.code, "ctop")))[0]!.id;
    const token = await signIn("superadmin");
    const page = (await (await call("GET", `/v1/spaces/${T}/sources?pageSize=25`, { token })).json()) as Page<SourceRowDto>;
    const by = new Map(page.items.map((r) => [r.name, r]));
    expect([...by.keys()].sort()).toEqual(["BI settlement file", "BI-RTGS statement", "Core bank · BI-FAST incoming", "Core bank · BI-FAST outgoing", "Core bank · RTGS",
      "Core bank · SKNBI", "GL nostro USD", "MT950 · Citi New York", "SKNBI clearing file"]);
    expect(Object.fromEntries([...by].map(([n, r]) => [n, r.status === "paused" ? "paused" : r.health?.state]))).toEqual({
      "BI settlement file": "healthy", "BI-RTGS statement": "degraded", "Core bank · BI-FAST incoming": "healthy", "Core bank · BI-FAST outgoing": "degraded",
      "Core bank · RTGS": "healthy", "Core bank · SKNBI": "degraded", "GL nostro USD": "paused", "MT950 · Citi New York": "healthy", "SKNBI clearing file": "healthy",
    });
    expect(by.get("BI settlement file")).toMatchObject({ rowsToday: 9, quarantinedToday: 1 });
    const bi = by.get("BI settlement file")!.id;
    const files = (await (await call("GET", `/v1/spaces/${T}/sources/${bi}/files`, { token })).json()) as Page<SourceFileDto>;
    expect(files.items.map((f) => [f.status, f.version])).toEqual([["ingested", 1], ["ingested", 2], ["rejected", null], ["ingested", 1], ["ingested", 1]]);
    expect(((await (await call("GET", `/v1/spaces/${T}/sources/${bi}/quarantine`, { token })).json()) as Page<unknown>).total).toBe(21);
    const gl = (await (await call("GET", `/v1/spaces/${T}/sources/${by.get("GL nostro USD")!.id}`, { token })).json()) as SourceDto;
    expect(gl.drift?.columns).toHaveLength(3);
    // the watermark lags sit mid-band of a day's grace, so the states hold for hours, not minutes
    expect(by.get("Core bank · BI-FAST incoming")!.health!.lagSeconds! / 60).toBeLessThan(5);
    expect(by.get("Core bank · BI-FAST outgoing")!.health!.lagSeconds! / 60).toBeGreaterThan(720);
    expect(by.get("Core bank · SKNBI")!.health!.missingDate).toBe(by.get("Core bank · SKNBI")!.health!.businessDate);
    // no event after the seed's now, and the next scheduled pull comes after the last attempt
    const now = Date.now();
    for (const name of ["Core bank · RTGS", "Core bank · SKNBI"]) {
      const id = by.get(name)!.id;
      const snaps = ((await (await call("GET", `/v1/spaces/${T}/sources/${id}/snapshots`, { token })).json()) as Page<SourceSnapshotDto>).items;
      const last = Math.max(...snaps.map((x) => Date.parse(x.startedAt)));
      expect(last).toBeLessThanOrEqual(now);
      const d = (await (await call("GET", `/v1/spaces/${T}/sources/${id}`, { token })).json()) as SourceDto;
      expect(Date.parse(d.nextRunAt!)).toBeGreaterThan(Math.max(last, now - 1000));
    }
    for (const f of files.items) expect(Date.parse(f.receivedAt)).toBeLessThanOrEqual(now);
    const viewer = await signIn("viewer");
    const shared = (await (await call("GET", `/v1/spaces/${C}/sources`, { token: viewer })).json()) as Page<SourceRowDto>;
    expect(shared.items).toMatchObject([{ name: "BI settlement file", owner: { spaceId: T, name: "Treasury" }, quarantinedToday: null }]);
  });

  it("the generator is deterministic", async () => {
    await seedSystem(db, {});
    await seedDemo(db);
    const names = async () =>
      (await db.select({ name: users.name, username: users.username, isActive: users.isActive }).from(users).orderBy(users.username)).map((r) => Object.values(r).join("|"));
    const first = await names();
    await truncateAll();
    await seedSystem(db, {});
    await seedDemo(db);
    expect(await names()).toEqual(first);
  });

  it("production refuses demo", async () => {
    await seedSystem(db, {});
    const err = await seedDemo(db, { NODE_ENV: "production" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await userCount()).toBe(0);
  });
});
