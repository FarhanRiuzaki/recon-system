import { describe, expect, it } from "vitest";
import { validateAll } from "@starterkit/ui/lib/validate";
import { SPACE_NAME_MAX } from "@starterkit/shared/spaces";
import { CREATE_SPACE_SCHEMA, createSpaceBody } from "./create-space-dialog";

const errors = (code: string, name: string) => validateAll({ code, name }, CREATE_SPACE_SCHEMA);

describe("Create space form: CreateSpaceBody's rules", () => {
  it("sends the code trimmed and lower-cased, the name trimmed", () => {
    expect(createSpaceBody({ code: "  Treasury-2 ", name: "  Treasury ops  " })).toEqual({ code: "treasury-2", name: "Treasury ops" });
  });
  it("a code of 2 to 32 letters, digits or hyphens, in any case, around spaces", () => {
    expect(errors("ab", "N")).toEqual({});
    expect(errors(" AB ", "N")).toEqual({});
    expect(errors("a".repeat(32), "N")).toEqual({});
    for (const bad of ["a", "a".repeat(33), "a b", "a_b", "kas!"]) expect(errors(bad, "N").code, bad).toBe("Use 2 to 32 letters, digits or hyphens.");
    expect(errors("", "N").code).toBe("Enter a code.");
    expect(errors("   ", "N").code).toBe("Enter a code.");
  });
  it("a name that is not only spaces, at most SPACE_NAME_MAX characters after trimming", () => {
    expect(errors("ab", "   ").name).toBe("Enter a name.");
    expect(errors("ab", ` ${"n".repeat(SPACE_NAME_MAX)} `)).toEqual({});
    expect(errors("ab", "n".repeat(SPACE_NAME_MAX + 1)).name).toBe(`Use ${SPACE_NAME_MAX} characters or fewer.`);
  });
});
