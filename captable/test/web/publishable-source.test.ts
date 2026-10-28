// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The web app's sources ship as they are, so they keep to a few plain rules: no unfinished-work markers, no copy that
// promises a later version (a page says what the app does now), nothing loaded from or linked to another site (the
// console shows the app in a sandboxed frame), and no promise of an e-mail (the app sends none). Every file of the web
// app (src/app without the shared contracts, the server, the database and the importer) and of these tests is read as
// raw text, so comments, copy, fixtures and styles are all covered, and plain regular expressions keep it quick.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ELSEWHERE = new Set(["src/app/shared", "src/app/server", "src/app/db", "src/app/import"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ELSEWHERE.has(relative(ROOT, path)) ? [] : files(path);
    return [path];
  });
}

// What no line may contain. This file is read too: the patterns and rule names are spelled so that they don't match
// themselves, and every sample below is assembled from pieces.
const RULES: [rule: string, pattern: RegExp][] = [
  ["an unfinished-work marker", /\b(?:TOD[O]|FIXM[E]|HAC[K]|XX[X])\b/],
  [
    "copy that promises a later version",
    /(?:\bnot|n't)\s+(?:available|built|supported|implemented|ready)\s+yet\b|\bcoming\s+soon\b|\b(?:in|with|for|until)\s+(?:a|the)\s+(?:future|later|next|coming)\s+(?:release|update|version)\b|\bin\s+this\s+(?:release|version)\b/i,
  ],
  ["a link or asset from another site", /\bhttps?:\/\/(?!localhost\b|www\.w3\.org\/)/i],
  ["a promise of an e-mail", /\b(?:you'll|you\s+will)\s+(?:get|receive)\s+an?\s+e-?mail\b|\bwe(?:'ll|\s+will)\s+(?:e-?mail|notify)\b/i],
];

function findings(name: string, text: string): string[] {
  return text.split("\n").flatMap((line, index) =>
    RULES.filter(([, pattern]) => pattern.test(line)).map(([rule]) => `${name}:${index + 1}: ${rule}: ${line.trim().slice(0, 140)}`),
  );
}

const sources = [...files(join(ROOT, "src/app")), ...files(join(ROOT, "test/web"))].map((path) => [relative(ROOT, path), readFileSync(path, "utf8")] as const);

describe("publishable web sources", () => {
  it("reads every web source, style and test, this file included, and nothing the other parts own", () => {
    const names = sources.map(([name]) => name);
    expect(names.length).toBeGreaterThan(140);
    for (const name of ["src/app/App.tsx", "src/app/app.css", "src/app/components/workspace.css", "test/web/setup.ts", "test/web/publishable-source.test.ts"]) {
      expect(names).toContain(name);
    }
    expect(names.filter((name) => /^src\/app\/(?:shared|server|db|import)\//.test(name))).toEqual([]);
  });

  it("finds no unfinished-work marker, promise of a later version, outside address or e-mail promise, comments included", () => {
    expect(sources.flatMap(([name, text]) => findings(name, text))).toEqual([]);
  });

  it.each([
    ["an unfinished-work marker", ["// TO", "DO: total the SAFEs as well."]],
    ["another unfinished-work marker", ["/* FIX", "ME: off by one at the cliff. */"]],
    ["a feature promised for later", ["<p>Bulk export arrives in a future ", "release.</p>"]],
    ["a page that says it isn't finished", ["{/* The settings page isn't built ", "yet. */}"]],
    ["a badge for a coming feature", ["<Badge>Coming ", "soon</Badge>"]],
    ["copy tied to the current version", ["sub=\"View only in this ", "release.\""]],
    ["a link out of the app", ["<a href=\"https:", "//help.example.invalid/cap-table\">Help</a>"]],
    ["a font from another site", ["@import url(\"https:", "//fonts.example.invalid/sans.css\");"]],
    ["a promise of an e-mail", ["<p>We'll e-", "mail the holder a copy.</p>"]],
  ])("catches %s", (_name, pieces) => {
    expect(findings("example.tsx", pieces.join(""))).toHaveLength(1);
  });

  it("leaves ordinary code and copy alone", () => {
    for (const line of [
      "const todos = items.filter((item) => !item.done);",
      "<p>A future date records a scheduled termination: vesting continues until then.</p>",
      "<span>Privacy notice not yet published</span>",
      "<p>Your portfolio isn't available right now</p>",
      "Expand first, contract in a later migration.",
      "const url = new URL(\"/api/me\", \"http://localhost\");",
      "<svg xmlns=\"http://www.w3.org/2000/svg\" />",
      "<p>Cap Table doesn't e-mail the holder, so let them know.</p>",
    ]) {
      expect(findings("example.tsx", line)).toEqual([]);
    }
  });
});
