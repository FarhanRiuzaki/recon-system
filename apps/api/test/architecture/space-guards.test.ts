// The space guards and the Members page's role matrix read the same role lists: every `{ space: … }` guard in a
// controller names SPACE_ROLES (any member) or one SPACE_ACTION list, never a literal array, and every SPACE_ACTION
// list guards at least one route. The matrix's cells come from SPACE_ACTION too
// (apps/web/src/features/spaces/role-matrix.test.ts "every space action is a row"), so the screen and the API can't drift.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SPACE_ACTION } from "@starterkit/shared/spaces";

const SRC = path.join(import.meta.dir, "../../src");
type File = { file: string; src: string };

/** Each `space:` value of a guard: SPACE_ROLES or SPACE_ACTION.<a known key>; and each key used at least once. */
export function spaceGuardViolations(files: readonly File[], keys: readonly string[] = Object.keys(SPACE_ACTION)): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (const { file, src } of files) {
    for (const m of src.matchAll(/guard:\s*\{\s*space:\s*([^,}]+?)\s*[,}]/g)) {
      const v = m[1]!;
      const key = /^SPACE_ACTION\.(\w+)$/.exec(v)?.[1];
      if (key && keys.includes(key)) used.add(key);
      else if (v !== "SPACE_ROLES") out.push(`${file}: guard { space: ${v} } names neither SPACE_ROLES nor a SPACE_ACTION list`);
    }
  }
  for (const k of keys) if (!used.has(k)) out.push(`SPACE_ACTION.${k} guards no route`);
  return out;
}

const controllers = (): File[] =>
  [...new Bun.Glob("modules/*/controller.ts").scanSync(SRC)].sort().map((file) => ({ file, src: readFileSync(path.join(SRC, file), "utf8") }));

describe("space guards read the shared role lists (role matrix drift)", () => {
  it("every { space } guard is SPACE_ROLES or a SPACE_ACTION list, and every list guards a route", () => {
    expect(spaceGuardViolations(controllers())).toEqual([]);
  });

  it("fixture: a literal role list, an unknown key, a spread and an unused key each fail", () => {
    const f = (src: string): File[] => [{ file: "modules/x/controller.ts", src }];
    expect(spaceGuardViolations(f(`.post("/a", h, { guard: { space: SPACE_ACTION.work } }).get("/b", h, { guard: { space: SPACE_ROLES, or: "space.view" } })`), ["work"])).toEqual([]);
    expect(spaceGuardViolations(f(`.post("/a", h, { guard: { space: ["operator"] } })`), [])).toEqual([
      `modules/x/controller.ts: guard { space: ["operator"] } names neither SPACE_ROLES nor a SPACE_ACTION list`,
    ]);
    expect(spaceGuardViolations(f(`.post("/a", h, { guard: { space: SPACE_ACTION.nope } })`), [])).toHaveLength(1);
    expect(spaceGuardViolations(f(`.post("/a", h, { guard: { space: [...MAKERS, "config_checker"] } })`), [])).toHaveLength(1);
    expect(spaceGuardViolations(f(`.post("/a", h, { guard: { space: SPACE_ACTION.work } })`), ["work", "idle"])).toEqual(["SPACE_ACTION.idle guards no route"]);
  });
});
