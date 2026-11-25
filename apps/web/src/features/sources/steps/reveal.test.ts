// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { focusControl } from "./reveal";

describe("focusControl", () => {
  it("opens the closed View as list around a control, then focuses it", () => {
    document.body.innerHTML = `<details><summary>View as list</summary><input id="src-derive-x"></details>`;
    focusControl("src-derive-x");
    expect(document.querySelector("details")!.open).toBe(true);
    expect(document.activeElement?.id).toBe("src-derive-x");
  });
});
