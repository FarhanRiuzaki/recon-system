import { describe, expect, it } from "vitest";
import { verbVariant } from "./intent";

describe("verbVariant (owner 24 Nov: actions by verb)", () => {
  it("Create / Add / New create, Edit / Replace edit, Delete / Remove remove, anything else the fallback", () => {
    expect(["Create recon", "Add member", "New workflow"].map((l) => verbVariant(l, "secondary"))).toEqual(["create", "create", "create"]);
    expect(["Edit source", "Replace key", "Continue editing"].map((l) => verbVariant(l, "secondary"))).toEqual(["edit", "edit", "edit"]);
    expect(["Delete draft", "Remove member"].map((l) => verbVariant(l, "secondary"))).toEqual(["remove", "remove"]);
    expect(["Editor settings", "Newer first", "Show who approves"].map((l) => verbVariant(l, "secondary"))).toEqual(["secondary", "secondary", "secondary"]);
  });
});
