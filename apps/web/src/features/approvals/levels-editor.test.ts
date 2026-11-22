import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Group, Level } from "@starterkit/shared/workflows";
import { emptyGroups, LevelCard } from "./levels-editor";

const group = (g: Partial<Group> = {}): Group => ({ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" }, ...g });
const options = { people: [{ id: "u1", name: "Rina" }], globalRoles: [] };
const card = (level: Level, editing: boolean, checked = false) => renderToStaticMarkup(h(LevelCard, {
  level, index: 0, count: 2, options, editing, checked, readOnly: false,
  onChange: () => {}, onEdit: () => {}, onDone: () => {}, onMove: () => {}, onRemove: () => {},
}));
/** The card's header row: marker, title and the actions, up to where the body starts. */
const head = (html: string) => html.slice(html.indexOf('data-slot="level-head"'), html.indexOf('data-slot="level-body"'));

describe("LevelCard (audit W1–W5)", () => {
  const level: Level = { name: "Treasury head", groups: [group()] };

  it("a level is the same card in read and edit mode: marker, title, actions in one header row", () => {
    const read = card(level, false), edit = card(level, true);
    for (const html of [read, edit]) {
      expect(html).toMatch(/^<li[^>]*data-slot="level-card"/);
      expect(head(html)).toContain(">1</span>");
      expect(head(html)).toContain("Level 1 · Treasury head");
    }
    expect(head(read)).toContain("Edit");
    expect(head(read)).toMatch(/<svg/); // Edit carries its icon
    expect(head(edit)).toContain(">Done<");
    expect(head(edit)).toContain('aria-label="Actions for level 1"');
  });

  it("group rows sit on the EditorRow grid, tops aligned; the X column is there with one group (invisible) and two (visible)", () => {
    const one = card(level, true);
    const removeOne = one.match(/<button[^>]*aria-label="Remove group 1 of level 1"[^>]*>/g) ?? [];
    expect(removeOne).toHaveLength(1);
    expect(removeOne[0]).toMatch(/\binvisible\b/);
    const two = card({ ...level, groups: [group(), group({ users: ["u1"] })] }, true);
    const removeTwo = two.match(/<button[^>]*aria-label="Remove group \d of level 1"[^>]*>/g) ?? [];
    expect(removeTwo).toHaveLength(2);
    for (const b of removeTwo) expect(b).not.toMatch(/\binvisible\b/);
    const rows = two.match(/<div data-slot="editor-row" class="[^"]*"/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(3); // name, two groups, add a group
    for (const r of rows) expect(r).toContain("items-start");
    expect(two.match(/data-slot="group-block"/g)).toHaveLength(2);
  });

  it("a group with nobody picked shows its error only once Done was pressed", () => {
    const empty: Level = { name: "", groups: [group({ spaceRoles: [] })] };
    expect(card(empty, true, false)).not.toContain("Pick who approves this group");
    expect(card(empty, true, true)).toContain("Pick who approves this group");
  });
});

describe("emptyGroups", () => {
  it("lists the groups with nobody picked", () => {
    expect(emptyGroups({ name: "", groups: [group(), group({ spaceRoles: [] }), group({ spaceRoles: [], users: ["u1"] })] })).toEqual([1]);
  });
});
