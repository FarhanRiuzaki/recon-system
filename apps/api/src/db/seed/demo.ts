import { eq, inArray, or, sql } from "drizzle-orm";
import type { ActivityAction } from "@starterkit/shared/audit";
import { PERMISSIONS } from "@starterkit/shared/permissions";
import type { AuthLogDto } from "@starterkit/shared/contracts/audit";
import { encryptSecret } from "../../kernel/crypto";
import type { Tx } from "../../kernel/db";
import { log } from "../../kernel/log";
import { activity as activityTable, authLog as authLogTable } from "../../modules/audit";
import { hashPassword, LDAP_PASSWORD } from "../../modules/auth";
import { userIdentities } from "../../modules/oauth";
import { importFeeds } from "../../modules/imports";
import { projects as projectsTable } from "../../modules/projects";
import { roles, userRoles } from "../../modules/rbac";
import { type SpaceRole, spaceMembers, spaces as spacesTable } from "../../modules/spaces";
import { recoveryCodes, users as usersTable } from "../../modules/users";
import { seedDemoSources } from "./demo-sources";
import { ensureRoles, type SeedRole } from "./roles";

export const SEED_PASSWORD = "Password123!";
/** Directory password of the demo LDAP account (username `ldap`), held by the mock directory (modules/auth/ldap.ts). */
export { LDAP_PASSWORD };
/** Fixed base32 TOTP secret of twofa@example.com. */
export const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
export const RECOVERY_CODES = ["aaaa-1111", "bbbb-2222", "cccc-3333", "dddd-4444", "eeee-5555", "ffff-6666", "gggg-7777", "hhhh-8888"];
const DAY = 86_400_000;
const USER_COUNT = 50;

/** mulberry32: small seeded PRNG. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Alya", "Bima", "Citra", "Dewa", "Eka", "Farah", "Gilang", "Hana", "Indra", "Juli", "Kirana", "Laksmi", "Mira", "Nanda", "Oka", "Putri", "Raka", "Sinta", "Tegar", "Wulan"];
const LAST = ["Pratama", "Wijaya", "Santoso", "Lestari", "Hidayat", "Kusuma", "Nugroho", "Saputra", "Rahma", "Utama"];
const DEVICES = ["Chrome on macOS", "Firefox on Windows", "Safari on iOS", "Edge on Windows", "Chrome on Android"];
const PLACES = ["Jakarta, ID", "Bandung, ID", "Surabaya, ID", "Singapore, SG", null];
/** Demo projects: more than one page of 15; every fourth archived. */
const PROJECTS = ["Apollo", "Borobudur", "Cendana", "Dieng", "Elang", "Flores", "Garuda", "Halmahera", "Ijen", "Jatiluhur", "Kawi", "Lombok",
  "Merapi", "Nias", "Orchid", "Prambanan", "Rinjani", "Sumba", "Toba", "Ubud"];

type Over = { isActive?: boolean; isLdap?: boolean; twoFactor?: boolean; connected?: "google" | "apple" };
const FIXED: { key: string; name: string; role: string; over?: Over }[] = [
  { key: "superadmin", name: "Super Admin", role: "Superadmin" },
  { key: "admin", name: "Admin User", role: "Admin" },
  { key: "viewer", name: "Viewer User", role: "Viewer" },
  { key: "twofa", name: "Two Factor", role: "Admin", over: { twoFactor: true } },
  { key: "inactive", name: "Inactive User", role: "Viewer", over: { isActive: false } },
  { key: "ldap", name: "Directory User", role: "Viewer", over: { isLdap: true } },
  { key: "google", name: "Google User", role: "Viewer", over: { connected: "google" } },
  { key: "apple", name: "Apple User", role: "Viewer", over: { connected: "apple" } },
];

// ponytail: hashes cached per process (argon2 is slow on purpose); tests reseed often.
let hashes: Promise<{ password: string; codes: string[] }> | undefined;

/** The demo's global roles, beside the system seed's: the demo accounts and the tests sign in with them. */
export const DEMO_ROLES: SeedRole[] = [
  { name: "Admin", locked: false, perms: PERMISSIONS.filter((p) => !p.startsWith("role.") && !p.startsWith("permission.")) },
  { name: "Viewer", locked: false, perms: ["user.view", "audit.view"] },
];

/**
 * the space roles ([space, username, roles]; Treasury holds all seven) and the global roles granted on top of
 * the space roles ([space, username, roles]; Treasury has one account per single role) and the global roles granted on top of
 * an account's own (Viewer). The generated usernames are fixed by the seeded generator.
 */
export const DEMO_ACCESS: { space: [code: "treasury" | "ctop" | "fico", username: string, roles: SpaceRole[]][]; global: Record<string, string[]> } = {
  space: [
    ["treasury", "hana.9", ["space_admin", "reviewer"]], ["treasury", "viewer", ["operator", "config_maker"]], ["treasury", "juli.13", ["config_checker"]],
    ["treasury", "tegar.15", ["source_admin"]], ["treasury", "superadmin", ["source_admin"]],
    ["treasury", "raka.18", ["operator"]], ["treasury", "putri.21", ["reviewer"]], ["treasury", "dewa.22", ["viewer"]],
    ["ctop", "hana.11", ["space_admin"]], ["ctop", "viewer", ["viewer"]], ["ctop", "juli.13", ["operator", "reviewer"]],
    ["fico", "sinta.12", ["space_admin", "config_checker"]], ["fico", "citra.17", ["operator", "viewer"]],
  ],
  global: { "gilang.33": ["Open API operator"], "laksmi.24": ["Open API admin"] },
};

/**
 * Demo data on top of seedSystem: the 8 sign-in accounts of the mock (password Password123!, `ldap` signs in through
 * the directory, `twofa` has TOTP and recovery codes, `google`/`apple` are linked), 42 generated users, 200 activity
 * and 300 sign-in log entries, and three spaces (Treasury, CTOP, FICO): `viewer` is a member of Treasury and CTOP,
 * `superadmin` a source admin of Treasury (the E2E's global session reads its sources), `google` of none; each space
 * admin is a generated active Viewer-role user, so the user tests that deactivate fixed accounts or every Admin never
 * meet the last-space-admin rule. Treasury's sources and their ingest rows: demo-sources.ts. Refused in production
 * unless ALLOW_DEMO_SEED=true (a trial: the demo accounts' password is the known SEED_PASSWORD); skipped when the demo
 * accounts exist; refused by name when a user already holds a demo username or email (e.g. SEED_SUPERADMIN_USERNAME=superadmin).
 */
export async function seedDemo(db: Tx, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (env.NODE_ENV === "production") {
    if (env.ALLOW_DEMO_SEED !== "true") throw new Error("Demo data is refused when NODE_ENV=production; set ALLOW_DEMO_SEED=true for a trial.");
    log.warn("ALLOW_DEMO_SEED: demo data under NODE_ENV=production; its accounts share a known password (trial only)");
  }
  if ((await db.select({ id: usersTable.id }).from(usersTable).where(eq(sql`lower(${usersTable.email})`, "admin@example.com")).limit(1)).length) {
    log.info("demo data exists: skipped");
    return;
  }
  if (!(await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Superadmin")).limit(1)).length) throw new Error("Run the system seed first (bun run db:seed).");
  // the demo's own roles (the system seed makes only Superadmin, Maker, Approver): Admin = every permission but roles
  // and permissions, Viewer = users and the activity log
  await db.transaction((tx) => ensureRoles(tx, DEMO_ROLES));
  const roleIds = new Map((await db.select({ name: roles.name, id: roles.id }).from(roles)).map((r) => [r.name, r.id]));
  const { password, codes } = await (hashes ??= Promise.all([hashPassword(SEED_PASSWORD), Promise.all(RECOVERY_CODES.map(hashPassword))])
    .then(([password, codes]) => ({ password, codes })));

  const now = Date.now();
  const rnd = prng(20261019);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const at = (ms: number) => new Date(ms);

  type U = { id: string; name: string; username: string; email: string; isActive: boolean; isLdap: boolean; twoFactor: boolean;
    connected: "google" | "apple" | null; role: string; lastLoginAt: Date | null; createdAt: Date };
  const users: U[] = [];
  const add = (key: string, name: string, role: string, over: Over = {}) => {
    const isActive = over.isActive ?? true;
    const lastLoginAt = over.isActive === false ? null : at(now - Math.floor(rnd() * 14 * DAY));
    const createdAt = at(now - (30 + Math.floor(rnd() * 60)) * DAY);
    users.push({ id: Bun.randomUUIDv7(), name, username: key, email: `${key}@example.com`, isActive, isLdap: over.isLdap ?? false,
      twoFactor: over.twoFactor ?? false, connected: over.connected ?? null, role, lastLoginAt, createdAt });
  };
  for (const f of FIXED) add(f.key, f.name, f.role, f.over);
  for (let i = FIXED.length; i < USER_COUNT; i++) {
    const first = pick(FIRST);
    const name = `${first} ${pick(LAST)}`;
    const roll = rnd();
    add(`${first.toLowerCase()}.${i + 1}`, name, roll < 0.2 ? "Admin" : "Viewer", { isActive: rnd() > 0.1 });
  }

  const taken = await db.select({ username: usersTable.username }).from(usersTable).where(or(
    inArray(sql`lower(${usersTable.username})`, users.map((u) => u.username.toLowerCase())), inArray(sql`lower(${usersTable.email})`, users.map((u) => u.email.toLowerCase()))));
  if (taken.length) throw new Error(`Demo data needs its own usernames; already taken: ${taken.map((t) => t.username).join(", ")}. Pick another SEED_SUPERADMIN_USERNAME and email.`);

  const actors = users.filter((u) => u.isActive && u.role !== "Viewer");
  const actions: ActivityAction[] = ["user.create", "user.update", "user.deactivate", "user.delete", "role.update", "role.create", "user.reset_password"];
  const activity = Array.from({ length: 200 }, () => {
    const actor = pick(actors);
    const target = pick(users);
    const action = pick(actions);
    const when = at(now - Math.floor(rnd() * 30 * DAY));
    const role = action.startsWith("role");
    return {
      id: Bun.randomUUIDv7(), at: when, actorId: actor.id, actorName: actor.name, action,
      targetType: role ? "role" : "user", targetId: role ? roleIds.get("Viewer")! : target.id, targetLabel: role ? "Viewer" : target.name,
      before: action === "user.update" ? { name: target.name } : null,
      after: action === "user.update" ? { name: `${target.name} (edited)` } : null,
    };
  });

  const events: AuthLogDto["event"][] = ["login_success", "login_success", "login_success", "login_failed", "logout", "password_ok", "2fa_success", "2fa_failed", "password_reset"];
  const authLog = Array.from({ length: 300 }, () => {
    const u = pick(users);
    const event = pick(events);
    const when = at(now - Math.floor(rnd() * 30 * DAY));
    return {
      id: Bun.randomUUIDv7(), at: when, userId: u.id, login: u.email, event, method: u.isLdap ? "ldap" : u.connected ?? "password",
      ip: `10.0.${Math.floor(rnd() * 8)}.${1 + Math.floor(rnd() * 250)}`, device: pick(DEVICES), location: pick(PLACES),
    };
  });

  await db.transaction(async (tx) => {
    await tx.insert(usersTable).values(users.map((u) => ({
      id: u.id, name: u.name, username: u.username, email: u.email, isActive: u.isActive, isLdap: u.isLdap,
      passwordHash: u.isLdap ? null : password, totpSecret: u.twoFactor ? encryptSecret(TOTP_SECRET) : null,
      lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, updatedAt: u.createdAt,
    })));
    await tx.insert(userRoles).values(users.map((u) => ({ userId: u.id, roleId: roleIds.get(u.role)! })));
    for (const u of users.filter((x) => x.twoFactor)) {
      await tx.insert(recoveryCodes).values(codes.map((codeHash) => ({ id: Bun.randomUUIDv7(), userId: u.id, codeHash })));
    }
    for (const u of users.filter((x) => x.connected)) {
      await tx.insert(userIdentities).values({ userId: u.id, provider: u.connected!, subject: `mock-${u.connected}-demo`, email: u.email });
    }
    await tx.insert(projectsTable).values(PROJECTS.map((name, i) => {
      const createdAt = at(now - (60 - i * 2) * DAY);
      return { id: Bun.randomUUIDv7(), name, description: i % 3 ? `Demo project ${name}.` : null, status: i % 4 === 3 ? "archived" : "active", createdAt, updatedAt: createdAt };
    }));
    const fixed = (key: string) => users.find((u) => u.username === key)!.id;
    const spaceIds = { treasury: Bun.randomUUIDv7(), ctop: Bun.randomUUIDv7(), fico: Bun.randomUUIDv7() };
    await tx.insert(spacesTable).values([["treasury", "Treasury"], ["ctop", "CTOP"], ["fico", "FICO"]].map(([code, name]) => ({ id: spaceIds[code as keyof typeof spaceIds], code: code!, name: name! })));
    await tx.insert(spaceMembers).values(DEMO_ACCESS.space.flatMap(([s, username, rs]) => rs.map((role) => ({ spaceId: spaceIds[s], userId: fixed(username), role }))));
    await tx.insert(userRoles).values(Object.entries(DEMO_ACCESS.global).flatMap(([username, rs]) => rs.map((r) => ({ userId: fixed(username), roleId: roleIds.get(r)! }))));
    // Import section (DEC-066): two host feeds entered for Monitoring only (scheduler off, no staging needed to list them)
    await tx.insert(importFeeds).values([["Demo KAI host", "DEMO_KAI_TLHIST"], ["Demo Garuda host", "DEMO_GARUDA_TLHIST"]].map(([name, historySource]) => ({
      id: Bun.randomUUIDv7(), name: name!,
      spec: { kind: "db_host", historySource, batchPrefix: "HISTORY_TLHIST", startDate: "2026-10-31", due: { time: "06:30", graceMinutes: 30 } },
    })));
    await seedDemoSources(tx, { treasury: spaceIds.treasury, ctop: spaceIds.ctop, maker: fixed("viewer"), checker: fixed("juli.13"), now });
    await tx.insert(activityTable).values(activity);
    await tx.insert(authLogTable).values(authLog);
  });
}
