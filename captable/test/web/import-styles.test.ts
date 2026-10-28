// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What jsdom can't show, checked in the stylesheet itself: a file picker is a label styled as a button around an input
// that is visually hidden but keyboard-focusable, so the focus ring has to be drawn on the label.

describe("the file picker's focus", () => {
  it("rings a label styled as a button while the hidden input inside it has focus", () => {
    const css = readFileSync(new URL("../../src/app/components/workspace.css", import.meta.url), "utf8");
    expect(css).toMatch(/label\.btn:focus-within\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  });
});
