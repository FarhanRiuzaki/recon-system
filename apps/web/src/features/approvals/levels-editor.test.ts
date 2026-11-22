// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Group, Level } from "@starterkit/shared/workflows";
import { emptyGroups, LevelCard, Levels } from "./levels-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("Levels: one open level, closed only once every group names someone; focus follows", () => {
  let root: Root | null = null;
  afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
  function Host({ start }: { start: Level[] }) {
    const [levels, setLevels] = useState(start);
    return h(Levels, { levels, onChange: setLevels, options, disabled: false });
  }
  async function mount(start: Level[]) {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(h(Host, { start })));
  }
  const press = async (name: string) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === name || x.textContent?.trim() === name)!;
    await act(async () => { b.focus(); b.click(); });
    await act(() => new Promise((r) => setTimeout(r, 5)));
  };
  const modes = () => [...document.querySelectorAll('[data-slot="level-card"]')].map((c) => c.getAttribute("data-mode"));
  const focused = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim();
  const nobody: Level = { name: "", groups: [group({ spaceRoles: [] })] };
  const full: Level = { name: "", groups: [group()] };

  it("Edit opens a level and focus lands on its Done; Done closes it and focus lands on its Edit", async () => {
    await mount([full, full]);
    await press("Edit level 2");
    expect(modes()).toEqual(["read", "edit"]);
    expect(focused()).toBe("Done");
    await press("Done");
    expect(modes()).toEqual(["read", "read"]);
    expect(focused()).toBe("Edit level 2");
  });

  it("Edit on another card keeps a level with a group naming nobody open, with its error and focus on its picker", async () => {
    await mount([full, nobody]);
    await press("Edit level 2");
    await press("Edit level 1");
    expect(modes()).toEqual(["read", "edit"]);
    expect(document.body.textContent).toContain("Pick who approves this group");
    expect(focused()).toBe("Level 2, group 1: approvers");
  });

  it("Add level does the same check; once it passes the new level opens with focus on its name", async () => {
    await mount([nobody]);
    await press("Edit level 1");
    await press("Add level 2");
    expect(modes()).toEqual(["edit"]);
    expect(document.body.textContent).toContain("Pick who approves this group");
    expect(focused()).toBe("Level 1, group 1: approvers");
  });

  it("Add level from a complete level opens the new one, focus on its name field", async () => {
    await mount([full]);
    await press("Edit level 1");
    await press("Add level 2");
    expect(modes()).toEqual(["read", "edit"]);
    expect(document.activeElement?.getAttribute("data-focus")).toBe("name");
  });

  const menu = async (n: number, label: string) => {
    const trigger = document.querySelector<HTMLElement>(`[aria-label="Actions for level ${n}"]`)!;
    await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent?.includes(label)) as HTMLElement;
    await act(async () => item.click());
    await act(() => new Promise((r) => setTimeout(r, 50)));
  };

  it("Remove, once confirmed, puts focus on the card now in its place (else the one before)", async () => {
    await mount([full, { name: "Second", groups: [group()] }, { name: "Third", groups: [group()] }]);
    await press("Edit level 2");
    await menu(2, "Remove level");
    const confirm = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((b) => b.textContent?.trim() === "Remove level") as HTMLElement;
    await act(async () => confirm.click());
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(modes()).toEqual(["read", "read"]);
    expect(focused()).toBe("Edit level 2"); // Third, now level 2
  });

  it("Move down keeps the level open in its new place, focus on its ⋯", async () => {
    await mount([full, { name: "Second", groups: [group()] }]);
    await press("Edit level 1");
    await menu(1, "Move down");
    expect(modes()).toEqual(["read", "edit"]);
    expect(document.querySelector('[data-slot="level-card"] h3')!.textContent).toBe("Level 1 · Second");
    expect(focused()).toBe("Actions for level 2");
  });

  it("the level title is a heading", () => {
    expect(card({ name: "Treasury head", groups: [group()] }, false)).toMatch(/<h3[^>]*>Level 1 · Treasury head<\/h3>/);
  });

  it("a newly added group enters; the groups already there don't", async () => {
    await mount([full]);
    await press("Edit level 1");
    await press("Add a group that must also approve");
    const blocks = [...document.querySelectorAll('[data-slot="group-block"]')].map((b) => b.classList.contains("animate-enter"));
    expect(blocks).toEqual([false, true]);
  });
});
