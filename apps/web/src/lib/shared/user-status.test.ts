import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SIGN_IN_METHOD, signInText } from "./user-status";

const read = (f: string) => readFileSync(path.resolve(import.meta.dirname, "../../features/users", f), "utf8");

describe("a user's sign-in method: one wording on the form, the list and the detail page", () => {
  it("names the directory account and the password the same way everywhere", () => {
    expect(SIGN_IN_METHOD).toBe("Sign-in method");
    expect(signInText(true)).toBe("Directory account");
    expect(signInText(false)).toBe("Password");
  });
  it("the screens take it from the helper, never their own words", () => {
    for (const f of ["user-form.tsx", "user-detail.tsx", "user-columns.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("signInText(");
      expect(src, f).not.toMatch(/"Directory( user)?"/);
    }
  });
});
