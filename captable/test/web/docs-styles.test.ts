// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What jsdom can't show, checked in the Docs' own classes (Tailwind, compiled from the source): a link that lands on a
// heading or a glossary term in the Docs moves the focus there, and the place it lands stays visible.

describe("the docs' focus", () => {
  const docs = readFileSync(new URL("../../src/app/components/Docs.tsx", import.meta.url), "utf8");
  const parts = readFileSync(new URL("../../src/app/pages/docs/parts.tsx", import.meta.url), "utf8");
  const landing = /const FOCUS_LANDING = cn\(([\s\S]*?)\);/.exec(docs)?.[1] ?? "";

  it("rings a focused heading or term when the keyboard led there, and never removes the ring", () => {
    expect(landing).toContain("[&_[tabindex='-1']:focus-visible]:outline-2");
    expect(landing).toContain("[&_[tabindex='-1']:focus-visible]:outline-ring");
    expect(docs).toMatch(/<article className=\{cn\([^)]*FOCUS_LANDING\)\}/);
    for (const source of [docs, parts]) expect(source).not.toMatch(/\boutline-(?:none|hidden|0)\b/);
  });

  it("marks a section or term a link lands on in the primary colour, however it was reached", () => {
    expect(landing).toContain("[&_:is(h2,h3,dt)[tabindex='-1']:focus]:text-primary");
    expect(landing).toContain("[&_:is(h2,h3,dt)[tabindex='-1']:focus]:underline");
  });

  it("stops a heading or term it scrolls to below the header", () => {
    expect(landing).toContain("[&_:is(h1,h2,h3,dt)]:scroll-mt-20");
  });
});
