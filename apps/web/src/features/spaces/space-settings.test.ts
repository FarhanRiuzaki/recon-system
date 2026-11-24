import { describe, expect, it, vi } from "vitest";
import { validateAll } from "@starterkit/ui/lib/validate";
import { SPACE_NAME_MAX } from "@starterkit/shared/spaces";
import { CREATE_SPACE_SCHEMA } from "./create-space-dialog";
import { archiveConfirm, renameBody, SPACE_SETTINGS_SCHEMA, spaceMore } from "./space-settings";

const space = { id: "s1", code: "ops", name: "Ops", status: "active" as const, createdAt: "", updatedAt: "", roles: [] };

describe("Space settings: rename and archive (PATCH /api/spaces/:id)", () => {
  it("the name follows the same rule as Create space", () => {
    expect(SPACE_SETTINGS_SCHEMA.name).toBe(CREATE_SPACE_SCHEMA.name);
    expect(validateAll({ name: "   " }, SPACE_SETTINGS_SCHEMA).name).toBe("Enter a name.");
    expect(validateAll({ name: "n".repeat(SPACE_NAME_MAX + 1) }, SPACE_SETTINGS_SCHEMA).name).toBe(`Use ${SPACE_NAME_MAX} characters or fewer.`);
  });
  it("sends the trimmed name, nothing when it didn't change", () => {
    expect(renameBody({ name: "  Treasury ops " }, space)).toEqual({ name: "Treasury ops" });
    expect(renameBody({ name: " Ops " }, space)).toBeNull();
  });
  it("only those the API lets change the space get the actions: settings, and archive (destructive, confirmed) or unarchive", () => {
    const run = { settings: vi.fn(), archive: vi.fn(async () => {}), unarchive: vi.fn() };
    expect(spaceMore(space, false, run)).toEqual([]);
    const active = spaceMore(space, true, run);
    expect(active.map((a) => [a.label, !!a.destructive])).toEqual([["Space settings", false], ["Archive space", true]]);
    expect(active[1]).toMatchObject({ confirm: { title: "Archive Ops", actionLabel: "Archive space" } });
    expect(spaceMore({ ...space, status: "archived" }, true, run).map((a) => a.label)).toEqual(["Space settings", "Unarchive space"]);
  });
  it("the archive confirmation says what stops and what keeps working", () => {
    const c = archiveConfirm(space, async () => {});
    expect(c.impact).toEqual(["Changes to the work in Ops are refused until it is unarchived.", "Every record stays and can be read; members and roles can still be managed."]);
  });
});
