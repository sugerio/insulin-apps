// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What jsdom can't show, checked in the source itself: a file picker is a label drawn as a button around an input that
// is visually hidden but keyboard-focusable, so the focus ring has to be drawn on the label, while the input inside has
// focus (Tailwind's focus-within), never removed.

describe("the file picker's focus", () => {
  const source = readFileSync(new URL("../../src/app/components/ImportWizard.tsx", import.meta.url), "utf8");

  it("rings the label drawn as a button while the hidden input inside it has focus", () => {
    const label = /<Button asChild variant="outline" size="sm">\s*<label\s+className="([^"]*)"/.exec(source);
    expect(label, "the file picker is a label inside shadcn/ui's Button").not.toBeNull();
    expect(label![1]).toMatch(/\bfocus-within:ring-3\b/);
    expect(label![1]).toMatch(/\bfocus-within:ring-ring\/50\b/);
    expect(label![1]).toMatch(/\bfocus-within:border-ring\b/);
  });

  it("keeps the input focusable: visually hidden, never display:none, and with no outline removed", () => {
    expect(source).toMatch(/<input\s+type="file"\s+className="sr-only"/);
    expect(source).not.toMatch(/outline-none[^"]*focus-within|focus-within[^"]*outline-none/);
  });
});
