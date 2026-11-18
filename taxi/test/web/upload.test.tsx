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
    expect(await within(reading).findByText("T4 from Maple Corp")).toBeTruthy();
    expect(within(reading).getByText("Skipped: Not a PDF, PNG or JPEG.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Uploaded files" })).toBeTruthy());
    const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList;
    expect(slips.slips).toEqual([expect.objectContaining({ source: "ai", unsure: ["22"], boxes: { 14: "60000", 22: "9000" } })]);
  });

  it("uploads into the open return, and lists only that return's files", async () => {
    let ids: { alex: string; sam: string } | undefined;
    const samReader: SlipReader = {
      read: async () => ({ kind: "read", taxYear: 2025, model: "m", slips: [{ type: "T4", person: "Sam Martin", issuer: "Island Grocers", boxes: { 14: "31000" }, unsure: [] }] }),
    };
    const { server } = await renderApp("/returns/2025/upload", {
      server: { reader: () => samReader },
      seed: async (s) => {
        const add = async (name: string, relationship: string, birthDate: string) =>
          ((await (await s.call("POST", "/api/people", { as: OWNER, body: { name, relationship, birthDate } })).json()) as Person).id;
        const alex = await add("Alex Martin", "self", "1985-04-02");
        const sam = await add("Sam Martin", "spouse", "1987-09-15");
        ids = { alex, sam };
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex, sam] } });
      },
    });
    fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 sam"], "sam.pdf", { type: "application/pdf" })] } });
    const reading = screen.getByRole("list", { name: "Files being read" });
    // Uploaded in Alex's return, but the slip names Sam: it goes to Sam's return.
    expect(await within(reading).findByText("T4 from Island Grocers, added to Sam Martin's return")).toBeTruthy();
    const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList;
    expect(slips.slips.map((slip) => slip.personId)).toEqual([ids!.sam]);
    const documents = (await (await server.call("GET", "/api/years/2025/documents")).json()) as { documents: { personId: string }[] };
    expect(documents.documents.map((document) => document.personId)).toEqual([ids!.alex]);
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
