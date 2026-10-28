// @vitest-environment node

import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { formData } from "../../src/app/api/request.ts";
import { MULTIPART_RESERVE, addFiles } from "../../src/app/lib/imports.ts";

// The server caps the whole encoded upload at 10 MiB, boundaries and part headers included, so the wizard keeps
// MULTIPART_RESERVE of it free for the encoding. Node encodes the form here as a browser would (same part headers, file
// names escaped and in UTF-8); only the boundary's length differs between encoders, and the check allows the longest.

/** The longest file name the contract takes: 255 UTF-16 units, each three bytes in UTF-8. */
function longestName(index: number): string {
  const name = `${String(index).padStart(2, "0")}${"株".repeat(248)}.xlsx`;
  expect(name).toHaveLength(255);
  return name;
}

describe("the multipart reserve", () => {
  it("covers the encoding of the largest form the wizard can send, whatever boundary the browser picks", async () => {
    const type = `application/${"x".repeat(200)}`;
    const files = Array.from({ length: api.IMPORT_LIMITS.files }, (_, index) => new File(["x"], longestName(index), { type }));
    const response = new Response(formData({ source: "template", files, asOfDate: "2026-10-20" }));
    const encoded = (await response.arrayBuffer()).byteLength;
    const boundary = /boundary=(.+)$/.exec(response.headers.get("content-type") ?? "")?.[1] ?? "";
    expect(boundary.length).toBeGreaterThan(0);
    const overhead = encoded - files.reduce((total, file) => total + file.size, 0);
    // RFC 2046 boundaries run to 70 characters: each delimiter (one per part, 27 of them, and the closing one) may be that long.
    const parts = files.length + 2;
    const worst = overhead + (70 - boundary.length) * (parts + 1);
    expect(worst).toBeLessThanOrEqual(MULTIPART_RESERVE);
  });

  it("so no selection the wizard accepts can exceed the server's limit once encoded", () => {
    const sized = (name: string, size: number) => {
      const made = new File(["x"], name);
      Object.defineProperty(made, "size", { value: size });
      return made;
    };
    // The largest selection: files at the per-file limit while they fit, then the rest of the room in one more file.
    const perFile = api.IMPORT_LIMITS.fileBytes;
    const room = api.IMPORT_LIMITS.requestBytes - MULTIPART_RESERVE;
    const sizes: number[] = [];
    for (let left = room; left > 0; left -= sizes.at(-1)!) sizes.push(Math.min(perFile, left));
    const largest = addFiles("pulley", [], sizes.map((size, index) => sized(`report-${index}.xlsx`, size)));
    expect(largest.refused).toEqual([]);
    const bytes = largest.files.reduce((total, item) => total + item.size, 0);
    expect(bytes).toBe(room);
    expect(bytes + MULTIPART_RESERVE).toBeLessThanOrEqual(api.IMPORT_LIMITS.requestBytes);
    expect(addFiles("pulley", largest.files, [sized("one-more.xlsx", 1)]).refused).toHaveLength(1);
  });
});
