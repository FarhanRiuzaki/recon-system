import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/client/api";
import { memberError } from "./member-dialogs";

describe("memberError", () => {
  it("a 409 last_space_admin says who and what to do; other errors keep the server's text", () => {
    expect(memberError(new ApiError(409, "last_space_admin", "server text"), "Rina")).toBe(
      "Space admin can't be removed: Rina is the only space admin, and a space needs at least one. Make someone else a space admin first.");
    expect(memberError(new ApiError(403, "forbidden", "Your role doesn't allow this."), "Rina")).toBe("Your role doesn't allow this.");
    expect(memberError(new TypeError("fetch failed"), "Rina")).toMatch(/can't be reached/);
  });
});
