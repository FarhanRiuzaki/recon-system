import { describe, expect, it } from "vitest";
import { unsaved } from "./autosave";

describe("unsaved: Send for approval waits for the last edit to reach the server", () => {
  it("the draft as loaded, nothing typed: nothing pending", () => {
    expect(unsaved('{"a":1}', null, '{"a":1}')).toBe(false);
  });
  it("an edit still in its debounce (or in flight) is pending", () => {
    expect(unsaved('{"a":2}', null, '{"a":1}')).toBe(true);
    expect(unsaved('{"a":3}', '{"a":2}', '{"a":1}')).toBe(true);
  });
  it("once saved, what is on screen is what the server holds", () => {
    expect(unsaved('{"a":2}', '{"a":2}', '{"a":1}')).toBe(false);
  });
});
