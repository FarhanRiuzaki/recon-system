import { describe, expect, it } from "vitest";
import { mayDo, SPACE_ACTION, SPACE_ROLES, type SpaceAction } from "./spaces";

describe("mayDo: the web offers a space action to exactly the roles its API guard lets in", () => {
  it("each role alone may do an action only when SPACE_ACTION lists it; several roles, when any does; none, never", () => {
    for (const a of Object.keys(SPACE_ACTION) as SpaceAction[]) {
      for (const r of SPACE_ROLES) expect(mayDo([r], a), `${r} ${a}`).toBe((SPACE_ACTION[a] as readonly string[]).includes(r));
      expect(mayDo([], a), a).toBe(false);
      expect(mayDo(["viewer", SPACE_ACTION[a][0]], a), a).toBe(true);
    }
  });
});
