import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Person, SlipList } from "#shared";
import type { SlipReader } from "../../src/app/server/lib/reader.ts";
import { OWNER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

const reader: SlipReader = {
  read: async () => ({
    kind: "read",
    taxYear: 2025,
    model: "test-model",
    slips: [{ type: "T4", person: "Alex Martin", issuer: "Maple Corp", boxes: { 14: "60000.00", 22: "9000.00" }, unsure: ["22"] }],
  }),
};

async function seed(server: TestServer) {
  const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
}

describe("Upload documents", () => {
  it("reads each chosen file and lists what it found, skipping files it can't read", async () => {
    const { server } = await renderApp("/returns/2025/upload", { seed, server: { reader: () => reader } });
    const input = await screen.findByLabelText("Choose files");
    const slip = new File(["%PDF-1.4 sample"], "T4 Alex.pdf", { type: "application/pdf" });
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [slip, notes] } });
    const reading = screen.getByRole("list", { name: "Files being read" });
    expect(await within(reading).findByText("T4 from Maple Corp for Alex Martin")).toBeTruthy();
    expect(within(reading).getByText("Skipped: Not a PDF, PNG or JPEG.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Uploaded files" })).toBeTruthy());
    const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList;
    expect(slips.slips).toEqual([expect.objectContaining({ source: "ai", unsure: ["22"], boxes: { 14: "60000", 22: "9000" } })]);
  });

  it("shows a slip read by AI in step 4, with the box to check and its file", async () => {
    await renderApp("/returns/2025/confirm", {
      server: { reader: () => reader },
      seed: async (server) => {
        await seed(server);
        await server.call("POST", "/api/years/2025/documents", {
          as: OWNER,
          raw: new TextEncoder().encode("%PDF-1.4 x") as Uint8Array<ArrayBuffer>,
          headers: { "Content-Type": "application/pdf", "X-File-Name": "t4.pdf" },
        });
      },
    });
    expect(await screen.findByText(/Box 22 Income tax deducted: \$9,000\.00 \(check\)/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "the uploaded file" }).getAttribute("href")).toMatch(/^\/api\/years\/2025\/documents\/[0-9a-f-]+\/file$/);
  });
});
