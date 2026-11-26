import { describe, expect, it } from "vitest";
import { emptySpec } from "@starterkit/shared/report-spec";
import {
  addColumn, addGroup, columnOfField, toggleSummary, draftProblem, widthOf, dataOnly, duplicateColumn, history, keyAction, moveColumn, patchColumn, removeColumn, removeGroup, replaceField, sendProblem, setFormat, specialColumn, toggleSection,
} from "./spec-model";

const ref = { ref: "a:ext_ref", label: "Reference", type: "text" as const, customer: false };
const amt = { ref: "a:amount_minor", label: "Amount", type: "number" as const, customer: false };
const two = () => addColumn(addColumn(emptySpec(), columnOfField(emptySpec(), ref)), columnOfField(addColumn(emptySpec(), columnOfField(emptySpec(), ref)), amt));

describe("columns", () => {
  it("a field's column: its label as header, a number format for numbers (2 decimals for amounts), new ids", () => {
    const s = two();
    expect(s.columns.map((c) => [c.id, c.header, c.format.kind, c.layout.align])).toEqual([["c1", "Reference", "auto", "l"], ["c2", "Amount", "number", "r"]]);
    expect(s.columns[1]!.format).toMatchObject({ decimals: 2, thousands: "." });
  });
  it("insert at a place, move, replace a field (header follows), duplicate beside, remove (its total too)", () => {
    let s = two();
    s = addColumn(s, specialColumn(s, "rownum"), 0);
    expect(s.columns.map((c) => c.header)).toEqual(["No", "Reference", "Amount"]);
    s = moveColumn(s, "c3", 3);
    expect(s.columns.map((c) => c.header)).toEqual(["Reference", "Amount", "No"]);
    s = replaceField(s, "c1", { ...ref, ref: "b:ext_ref", label: "Core reference" });
    expect(s.columns[0]).toMatchObject({ header: "Core reference", content: { kind: "field", ref: "b:ext_ref" } });
    s = duplicateColumn(s, "c2");
    expect(s.columns.map((c) => c.header)).toEqual(["Core reference", "Amount", "Amount (copy)", "No"]);
    s = { ...s, totals: { ...s.totals, columns: { c2: "sum" } } };
    s = removeColumn(s, "c2");
    expect([s.columns.length, s.totals.columns]).toEqual([3, {}]);
    expect(patchColumn(s, "c1", { header: "Ref" }).columns[0]!.header).toBe("Ref");
  });
  it("formula and fixed-text columns start filled", () => {
    expect(specialColumn(emptySpec(), "formula").content).toEqual({ kind: "formula", cel: "a.amount_minor - b.amount_minor" });
    expect(specialColumn(emptySpec(), "text").content).toEqual({ kind: "text", text: "" });
  });
});

describe("groups, sections, format", () => {
  it("a field groups once, at most three; removed by place", () => {
    let s = addGroup(addGroup(emptySpec(), "recon:status"), "recon:status");
    expect(s.groups).toEqual(["recon:status"]);
    s = addGroup(addGroup(addGroup(s, "a:attrs.x"), "a:attrs.y"), "a:attrs.z");
    expect(s.groups.length).toBe(3);
    expect(removeGroup(s, 0).groups).toEqual(["a:attrs.x", "a:attrs.y"]);
  });
  it("removing the last group also ends Summary only, so the draft stays valid and the preview drops the grouping (owner 26 Nov)", () => {
    const s = toggleSummary(addGroup(emptySpec(), "recon:status"));
    expect(s.summaryOnly).toBe(true);
    const r = removeGroup(s, 0);
    expect(r.groups).toEqual([]);
    expect(r.summaryOnly).toBe(false);
    expect(draftProblem(r)).toBeNull();
  });
  it("each section toggles; Data only turns every one off with the totals", () => {
    const e = emptySpec();
    expect(toggleSection(e, "title").sections.title.on).toBe(false);
    expect(toggleSection(e, "columnHeaders").sections.columnHeaders).toBe(false);
    expect(toggleSection(e, "totals").totals.on).toBe(false);
    const d = dataOnly(e);
    expect([d.sections.title.on, d.sections.header.on, d.sections.columnHeaders, d.sections.footer.on, d.totals.on]).toEqual([false, false, false, false, false]);
  });
  it("a format switch; full customer data needs official", () => {
    expect(setFormat(two(), "txt").output.format).toBe("txt");
  });
  it("send needs a column", () => {
    expect(sendProblem(emptySpec())).toBe("Add at least one column.");
    expect(sendProblem(two())).toBeNull();
  });
});

describe("history and keys", () => {
  it("undo and redo walk the edits; a new edit drops what was undone", () => {
    let h = history.start(emptySpec());
    h = history.push(h, two());
    h = history.undo(h);
    expect(h.now.columns.length).toBe(0);
    h = history.redo(h);
    expect(h.now.columns.length).toBe(2);
    h = history.push(history.undo(h), dataOnly(emptySpec()));
    expect(h.future).toEqual([]);
  });
  it("keys: Ctrl/⌘+Z undo, +Shift redo, Delete removes the selected column, Alt+arrows move it; nothing while typing", () => {
    const k = (o: Partial<Parameters<typeof keyAction>[0]>) => keyAction({ key: "", ctrl: false, shift: false, alt: false, typing: false, selected: true, ...o });
    expect([k({ key: "z", ctrl: true }), k({ key: "Z", ctrl: true, shift: true }), k({ key: "Delete" }), k({ key: "ArrowLeft", alt: true }), k({ key: "ArrowRight", alt: true })])
      .toEqual(["undo", "redo", "remove", "left", "right"]);
    expect(k({ key: "Delete", typing: true })).toBeNull();
    expect(k({ key: "Delete", selected: false })).toBeNull();
  });

describe("summary only", () => {
  it("on: numbers not grouped by get a sum; off again leaves the totals; it needs a group to be sent", () => {
    const s = addGroup(two(), "a:ext_ref");
    const on = toggleSummary(s);
    expect([on.summaryOnly, on.totals.on, on.totals.columns]).toEqual([true, true, { c2: "sum" }]);
    expect(toggleSummary(on).summaryOnly).toBe(false);
    expect(sendProblem({ ...two(), summaryOnly: true })).toBe("Group by at least one field for a summary.");
  });
});
});

describe("minors", () => {
  it("typing in one field is one undo step (same key within a second); another field starts a new step", () => {
    let h = history.start(emptySpec());
    h = history.push(h, { ...emptySpec(), output: { ...emptySpec().output, fileName: "a" } }, "file", 1000);
    h = history.push(h, { ...emptySpec(), output: { ...emptySpec().output, fileName: "ab" } }, "file", 1500);
    expect(h.past.length).toBe(1);
    h = history.push(h, { ...h.now, official: true }, "official", 1600);
    expect(h.past.length).toBe(2);
    h = history.push(h, { ...h.now, output: { ...h.now.output, fileName: "abc" } }, "file", 3000);
    expect(h.past.length).toBe(3);
  });
  it("a draft the API would refuse is said, not sent: an empty formula, made neither after runs nor on request", () => {
    expect(draftProblem(emptySpec())).toBeNull();
    expect(draftProblem({ ...two(), columns: [{ ...two().columns[0]!, header: "Diff", content: { kind: "formula", cel: " " } }] })).toBe("Diff: write the formula.");
    expect(draftProblem({ ...emptySpec(), when: { afterRun: false, onRequest: false } })).toBe("Make it after every run, on request, or both.");
    // the API refuses an empty file name (min 1): the save waits and says why instead of failing
    expect(draftProblem({ ...emptySpec(), output: { ...emptySpec().output, fileName: "  " } })).toBe("Name the file.");
  });
  it("the width input: digits clamp to 1–200, empty or text is no width yet", () => {
    expect([widthOf("12"), widthOf("0"), widthOf("999"), widthOf(""), widthOf("x")]).toEqual([12, 1, 200, null, null]);
  });
});
