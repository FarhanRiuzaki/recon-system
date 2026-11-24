import { describe, expect, it } from "vitest";
import { membershipProblems } from "./membership";

describe("adding a membership (Add member on a space, Add to space on a user): one rule, one wording", () => {
  it("names what is missing: the person or the space, and a role", () => {
    expect(membershipProblems({ target: null, roles: [] }, "person")).toEqual({ target: "Pick a person.", roles: "Pick at least one role." });
    expect(membershipProblems({ target: null, roles: ["viewer"] }, "space")).toEqual({ target: "Pick a space.", roles: null });
    expect(membershipProblems({ target: "u1", roles: ["viewer"] }, "person")).toBeNull();
  });
});
