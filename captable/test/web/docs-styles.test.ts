// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What jsdom can't show, checked in the stylesheet itself: a link that lands on a heading or a glossary term in the Docs
// moves the focus there, and the place it lands stays visible.

describe("the docs' focus", () => {
  const css = readFileSync(new URL("../../src/app/components/docs.css", import.meta.url), "utf8");

  it("rings a focused heading or term when the keyboard led there, and never removes the ring", () => {
    expect(css).toMatch(/\.docs-article \[tabindex="-1"\]:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
    expect(css).not.toMatch(/outline:\s*(?:none|0)\b/);
  });

  it("marks a section or term a link lands on in the primary colour, however it was reached", () => {
    expect(css).toMatch(/\.docs-section h2:focus,\s*\.docs-article h3:focus,\s*\.docs-glossary dt:focus\s*\{[^}]*color:\s*var\(--primary\)/);
  });
});
