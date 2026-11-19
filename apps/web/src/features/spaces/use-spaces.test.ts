import { expect, it } from "vitest";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { ROLE_DESCRIPTION, ROLE_LABEL, spaceHref } from "./use-spaces";

it("every space role has a label and a description", () => {
  for (const r of SPACE_ROLES) { expect(ROLE_LABEL[r]).toBeTruthy(); expect(ROLE_DESCRIPTION[r]).toBeTruthy(); }
  expect(Object.keys(ROLE_LABEL)).toHaveLength(SPACE_ROLES.length);
});
it("spaceHref encodes the id", () => { expect(spaceHref("a/b", "members")).toBe("/spaces/a%2Fb/members"); });
