import "./setup.ts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Person, SlipList, TaxYear } from "#shared";
import type { SlipReader } from "../../src/app/server/lib/reader.ts";
import { OWNER, type TestServer } from "../support/server.ts";
import { catchDownloads, clickWhenEnabled, renderApp } from "./support.tsx";

const reader: SlipReader = {
  read: async () => ({
    kind: "read",
    taxYear: 2025,
    model: "test-model",
    slips: [{ type: "T4", person: "Alex Martin", issuer: "Maple Corp", boxes: { 14: "60000.00", 22: "9000.00" }, unsure: ["22"] }],
  }),
};

async function addAlex(server: TestServer) {
  const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
  return alex;
}

async function seed(server: TestServer) {
  await addAlex(server);
}

/** Alex alone, single, in Ontario, with step 1 saved; and the year then. */
async function alexWithFacts(server: TestServer) {
  const alex = await addAlex(server);
  const response = await server.call("PUT", "/api/years/2025/personal-info", {
    as: OWNER,
    body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] },
  });
  return { alex, year: (await response.json()) as TaxYear };
}

async function seedWithFacts(server: TestServer) {
  await alexWithFacts(server);
}

const RRSP = "RRSP contributions to deduct for 2025";
const rrspField = () => screen.findByLabelText(RRSP) as Promise<HTMLInputElement>;

/** Uploads a file whose reading is held, then opens Deductions while it is read. */
async function uploadThenOpenDeductions(router: { navigate: (to: string) => Promise<void>; state: { location: { pathname: string } } }) {
  fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 late"], "late.pdf", { type: "application/pdf" })] } });
  await act(() => router.navigate(router.state.location.pathname.replace(/upload$/, "deductions")));
  return screen.findByRole("region", { name: "On your return" });
}

/** The upload has finished: the year changed, and the form started again from it. */
const uploadFinished = () => screen.findByRole("link", { name: /Upload documents\s*\(done\)/ });

/** A promise held until `release` is called. */
function hold() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
}

const documentNames = async (server: TestServer) =>
  ((await (await server.call("GET", "/api/years/2025/documents")).json()) as { documents: { name: string }[] }).documents.map((document) => document.name);

describe("Upload documents", () => {
  it("reads each chosen file and lists what it found, skipping files it can't read", async () => {
    const { server } = await renderApp("/returns/2025/upload", { seed, server: { reader: () => reader } });
    const input = await screen.findByLabelText("Choose files");
    const slip = new File(["%PDF-1.4 sample"], "T4 Alex.pdf", { type: "application/pdf" });
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [slip, notes] } });
    // A saved file moves to "Uploaded files"; one that wasn't stays in this upload's list with why.
    expect(await screen.findByText("T4 from Maple Corp")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Uploaded files" })).toBeTruthy();
    const upload = screen.getByRole("list", { name: "This upload" });
    expect(within(upload).getByText("Skipped: Not a PDF, PNG or JPEG.")).toBeTruthy();
    expect(within(upload).queryByText("T4 Alex.pdf")).toBeNull();
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
    // Uploaded in Alex's return, but the slip names Sam: it goes to Sam's return.
    expect(await screen.findByText("T4 from Island Grocers, added to Sam Martin's return")).toBeTruthy();
    const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList;
    expect(slips.slips.map((slip) => slip.personId)).toEqual([ids!.sam]);
    const documents = (await (await server.call("GET", "/api/years/2025/documents")).json()) as { documents: { personId: string }[] };
    expect(documents.documents.map((document) => document.personId)).toEqual([ids!.alex]);
  });

  it("doesn't save the same file twice, whatever its name", async () => {
    await renderApp("/returns/2025/upload", { seed, server: { reader: () => reader } });
    const input = await screen.findByLabelText("Choose files");
    fireEvent.change(input, { target: { files: [new File(["%PDF-1.4 same"], "T4.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("T4 from Maple Corp")).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(["%PDF-1.4 same"], "T4 copy.pdf", { type: "application/pdf" })] } });
    const upload = await screen.findByRole("list", { name: "This upload" });
    expect(await within(upload).findByText("The same file is already here, as T4.pdf.")).toBeTruthy();
    expect(within(upload).getByText("Already here")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Download T4/ }).map((button) => button.textContent)).toEqual(["T4.pdf"]);
  });

  it("says when a file replaced an earlier version of the same name", async () => {
    let box = "60000.00";
    const changing: SlipReader = {
      read: async () => ({ kind: "read", taxYear: 2025, model: "m", slips: [{ type: "T4", person: "Alex Martin", issuer: "Maple Corp", boxes: { 14: box }, unsure: [] }] }),
    };
    await renderApp("/returns/2025/upload", { seed, server: { reader: () => changing } });
    const input = await screen.findByLabelText("Choose files");
    fireEvent.change(input, { target: { files: [new File(["%PDF-1.4 v1"], "T4.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("T4 from Maple Corp")).toBeTruthy();
    box = "61000.00";
    fireEvent.change(input, { target: { files: [new File(["%PDF-1.4 v2"], "T4.pdf", { type: "application/pdf" })] } });
    const upload = await screen.findByRole("list", { name: "This upload" });
    expect(await within(upload).findByText("Replaced the earlier T4.pdf and its slip. T4 from Maple Corp")).toBeTruthy();
    expect(within(upload).getByText("Replaced")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Download T4.pdf" })).toHaveLength(1));
  });

  it("deletes a file with its slips, after saying which slips go", async () => {
    const { server } = await renderApp("/returns/2025/upload", {
      server: { reader: () => reader },
      seed: async (s) => {
        await seed(s);
        await s.call("POST", "/api/years/2025/documents", {
          as: OWNER,
          raw: new TextEncoder().encode("%PDF-1.4 x") as Uint8Array<ArrayBuffer>,
          headers: { "Content-Type": "application/pdf", "X-File-Name": "wrong.pdf" },
        });
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Delete wrong.pdf" }));
    expect(screen.getByText("Delete wrong.pdf?")).toBeTruthy();
    expect(screen.getByText("T4 from Maple Corp, on Alex Martin's return")).toBeTruthy();
    // Cancel keeps it; Delete file deletes it and its slip.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete wrong.pdf?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete wrong.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Uploaded files" })).toBeNull());
    expect(((await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList).slips).toEqual([]);
  });

  it("reads a file again when reading it failed", async () => {
    let fail = true;
    const flaky: SlipReader = { read: async (file, context) => (fail ? { kind: "failed", message: "AI reading failed (500). Try again." } : reader.read(file, context)) };
    await renderApp("/returns/2025/upload", {
      server: { reader: () => flaky },
      seed: async (s) => {
        await seed(s);
        await s.call("POST", "/api/years/2025/documents", {
          as: OWNER,
          raw: new TextEncoder().encode("%PDF-1.4 y") as Uint8Array<ArrayBuffer>,
          headers: { "Content-Type": "application/pdf", "X-File-Name": "flaky.pdf" },
        });
      },
    });
    expect(await screen.findByText("Couldn't read")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Read flaky.pdf again" }));
    expect(await screen.findByText("T4 from Maple Corp")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read flaky.pdf again" })).toBeNull();
  });

  it("keeps an amount typed on another step while an upload is still being read", async () => {
    const { held, release } = hold();
    const late: SlipReader = { read: async (file, context) => (await held, reader.read(file, context)) };
    const { router, server } = await renderApp("/returns/2025/upload", { seed: seedWithFacts, server: { reader: () => late } });
    fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 late"], "T4.pdf", { type: "application/pdf" })] } });
    // While it is read, Alex goes on to Deductions and types an amount, not saved yet.
    await act(() => router.navigate(router.state.location.pathname.replace(/upload$/, "deductions")));
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add RRSP contributions to deduct for 2025" }));
    fireEvent.change(screen.getByLabelText("RRSP contributions to deduct for 2025"), { target: { value: "2,500" } });
    // The upload finishes: the year changes (the upload step is done), and the form starts again from it.
    release();
    expect(await screen.findByRole("link", { name: /Upload documents\s*\(done\)/ })).toBeTruthy();
    expect(((await screen.findByLabelText("RRSP contributions to deduct for 2025")) as HTMLInputElement).value).toBe("2,500");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const estimate = (await (await server.call("GET", "/api/years/2025/estimate")).json()) as { input: { answers: Record<string, Record<string, unknown>> } };
      expect(Object.values(estimate.input.answers)[0]).toMatchObject({ rrspDeduction: "2500" });
    });
  });

  it("shows an answer saved elsewhere meanwhile over the amount typed for it", async () => {
    const { held, release } = hold();
    const late: SlipReader = { read: async (file, context) => (await held, reader.read(file, context)) };
    const { router, server } = await renderApp("/returns/2025/upload", { seed: seedWithFacts, server: { reader: () => late } });
    fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 late"], "T4.pdf", { type: "application/pdf" })] } });
    await act(() => router.navigate(router.state.location.pathname.replace(/upload$/, "deductions")));
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add RRSP contributions to deduct for 2025" }));
    fireEvent.change(screen.getByLabelText("RRSP contributions to deduct for 2025"), { target: { value: "2,500" } });
    // The same answer is saved from somewhere else before the upload finishes.
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    await server.call("PUT", "/api/years/2025/answers", { as: OWNER, body: { revision: year.revision, personId: year.adults[0]!.personId, answers: { rrspDeduction: "3000" } } });
    release();
    expect(await screen.findByRole("link", { name: /Upload documents\s*\(done\)/ })).toBeTruthy();
    expect(((await screen.findByLabelText("RRSP contributions to deduct for 2025")) as HTMLInputElement).value).toBe("3000");
  });

  it("gives way to an answer saved elsewhere after it was removed here, rather than saving 0 over it", async () => {
    const { held, release } = hold();
    const late: SlipReader = { read: async (file, context) => (await held, reader.read(file, context)) };
    const { router, server } = await renderApp("/returns/2025/upload", {
      server: { reader: () => late },
      seed: async (s) => {
        const { alex, year } = await alexWithFacts(s);
        await s.call("PUT", "/api/years/2025/answers", { as: OWNER, body: { revision: year.revision, personId: alex.id, answers: { rrspDeduction: "1000" } } });
      },
    });
    const onReturn = await uploadThenOpenDeductions(router);
    fireEvent.click(within(onReturn).getByRole("button", { name: `Remove ${RRSP}` }));
    // Saved from somewhere else (another tab, an agent) while the removal is pending here.
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    await server.call("PUT", "/api/years/2025/answers", { as: OWNER, body: { revision: year.revision, personId: year.adults[0]!.personId, answers: { rrspDeduction: "3000" } } });
    release();
    await uploadFinished();
    expect((await rrspField()).value).toBe("3000");
  });

  it("keeps an amount typed for an unanswered deduction when a receipt's suggestion arrives", async () => {
    const { held, release } = hold();
    const receipt: SlipReader = {
      read: async () => (
        await held, { kind: "read", taxYear: 2025, model: "m", slips: [{ type: "RRSP", person: "Alex Martin", issuer: "Lakeview Credit Union", boxes: { 1: "6000" }, unsure: [] }] }
      ),
    };
    const { router } = await renderApp("/returns/2025/upload", { seed: seedWithFacts, server: { reader: () => receipt } });
    await uploadThenOpenDeductions(router);
    fireEvent.click(within(screen.getByRole("region", { name: "Add to your return" })).getByRole("button", { name: `Add ${RRSP}` }));
    fireEvent.change(await rrspField(), { target: { value: "2,500" } });
    release();
    await uploadFinished();
    expect(await screen.findByText(/From your documents: \$6,000\.00/)).toBeTruthy();
    expect((await rrspField()).value).toBe("2,500");
  });

  it("takes no changes while the module is being saved", async () => {
    await renderApp("/returns/2025/deductions", { seed: seedWithFacts });
    const add = await screen.findByRole("region", { name: "Add to your return" });
    // The save is held: what is typed meanwhile would be lost when it comes back.
    const { held, release } = hold();
    const send = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === "PUT" && String(input).endsWith("/answers")) await held;
      return send(input, init);
    });
    fireEvent.click(within(add).getByRole("button", { name: `Add ${RRSP}` }));
    fireEvent.change(await rrspField(), { target: { value: "2,500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await rrspField()).disabled).toBe(true));
    expect((within(add).getByRole("button", { name: "Add Working from home" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: `Remove ${RRSP}` }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(async () => expect((await rrspField()).disabled).toBe(false));
    expect((await rrspField()).value).toBe("2500");
  });

  it("keeps the newest year when an upload in the other return answers late", async () => {
    const ids: { alex?: string; sam?: string } = {};
    // Each file holds the slip of whoever's return it is uploaded in.
    const byFile: SlipReader = {
      read: async (file) => {
        const person = new TextDecoder().decode(file.bytes).includes("sam") ? "Sam Martin" : "Alex Martin";
        return { kind: "read", taxYear: 2025, model: "m", slips: [{ type: "T4", person, issuer: `${person}'s employer`, boxes: { 14: "1000" }, unsure: [] }] };
      },
    };
    const { router, server } = await renderApp("/returns/2025/upload", {
      server: { reader: () => byFile },
      seed: async (s) => {
        const add = async (name: string, relationship: string, birthDate: string) =>
          ((await (await s.call("POST", "/api/people", { as: OWNER, body: { name, relationship, birthDate } })).json()) as Person).id;
        ids.alex = await add("Alex Martin", "self", "1985-04-02");
        ids.sam = await add("Sam Martin", "spouse", "1987-09-15");
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [ids.alex, ids.sam] } });
      },
    });
    // The server saves Alex's file, but its answer is held back until Sam has uploaded too.
    const { held, release } = hold();
    let answered = false;
    const send = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const response = await send(input, init);
      if (init.method === "POST" && new Headers(init.headers).get("X-Person-Id") === ids.alex) {
        await held;
        answered = true;
      }
      return response;
    });
    fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 alex"], "alex.pdf", { type: "application/pdf" })] } });
    await waitFor(async () => expect(await documentNames(server)).toEqual(["alex.pdf"]));
    await act(() => router.navigate(`/returns/2025/${ids.sam}/upload`));
    fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 sam"], "sam.pdf", { type: "application/pdf" })] } });
    await screen.findByRole("button", { name: "Delete sam.pdf" });
    const newest = ((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).revision;
    // Alex's answer arrives now, with the year as it was before Sam's upload.
    release();
    await waitFor(() => expect(answered).toBe(true));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    // Deleting Sam's file sends the newest revision, so it isn't refused.
    fireEvent.click(screen.getByRole("button", { name: "Delete sam.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    await waitFor(async () => expect(await documentNames(server)).toEqual(["alex.pdf"]));
    expect(((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).revision).toBe(newest + 1);
  });

  it("says what came of a slip uploaded in a card, once the year is refreshed", async () => {
    // No reader given: AI reading isn't set up, so the file is stored but not read.
    await renderApp("/returns/2025/income", { seed: seedWithFacts });
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Interest or dividends" }));
    fireEvent.change(screen.getByLabelText("Upload the T5"), { target: { files: [new File(["%PDF-1.4 t5"], "t5.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText(/^t5\.pdf: Files can't be read here yet\./, undefined, { timeout: 5000 })).toBeTruthy();
  });

  it("flags at Confirm a slip that may be the same as one above it, without stopping it being confirmed", async () => {
    await renderApp("/returns/2025/confirm", {
      seed: async (s) => {
        const { alex, year } = await alexWithFacts(s);
        let revision = year.revision;
        for (const [type, issuer, boxes] of [
          ["T4", "Maple Corp", { 14: "60000" }],
          ["T4", "Maple Corp", { 14: "60000", 22: "9000" }],
          ["T4", "Harbour Cafe", { 14: "1000" }],
          ["MEDICAL", "Lakeview Pharmacy", { 1: "25" }],
          ["MEDICAL", "Lakeview Pharmacy", { 1: "25" }],
        ] as const) {
          const response = await s.call("POST", "/api/years/2025/slips", { as: OWNER, body: { revision, personId: alex.id, type, issuer, boxes } });
          revision = ((await response.json()) as TaxYear).revision;
        }
      },
    });
    const notes = await screen.findAllByText(/^May be the same slip as/);
    expect(notes.map((note) => note.textContent)).toEqual(["May be the same slip as the T4 from Maple Corp above: if so, remove one; if they're different slips, keep both."]);
    expect(within(notes[0]!.closest("li")!).getByText(/Box 22/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm 5 slips and continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a slip read from a file at Confirm, with the box to check and its file", async () => {
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
    const saved = catchDownloads();
    fireEvent.click(screen.getByRole("button", { name: "Download the original file" }));
    await waitFor(() => expect(saved.map((file) => file.name)).toEqual(["t4.pdf"]));
    expect(await saved[0]!.blob.text()).toBe("%PDF-1.4 x");
  });

  it("says at Confirm why an original file couldn't be downloaded", async () => {
    const { server } = await renderApp("/returns/2025/confirm", {
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
    const saved = catchDownloads();
    await screen.findByRole("button", { name: "Download the original file" });
    await deleteFileElsewhere(server);
    fireEvent.click(screen.getByRole("button", { name: "Download the original file" }));
    expect(await screen.findByText("No such file in this year")).toBeTruthy();
    expect(saved).toEqual([]);
  });

  it("downloads an uploaded file from its name, and says why when it can't", async () => {
    const { server } = await renderApp("/returns/2025/upload", {
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
    const saved = catchDownloads();
    fireEvent.click(await screen.findByRole("button", { name: "Download t4.pdf" }));
    await waitFor(() => expect(saved.map((file) => file.name)).toEqual(["t4.pdf"]));
    expect(await saved[0]!.blob.text()).toBe("%PDF-1.4 x");
    await deleteFileElsewhere(server);
    await clickWhenEnabled(() => screen.getByRole("button", { name: "Download t4.pdf" }));
    expect(await screen.findByText("No such file in this year")).toBeTruthy();
    expect(saved).toHaveLength(1);
  });
});

/** Deletes the year's only uploaded file as another tab would, while the page still shows it. */
async function deleteFileElsewhere(server: TestServer) {
  const { documents } = (await (await server.call("GET", "/api/years/2025/documents")).json()) as { documents: { id: string }[] };
  const { revision } = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
  expect((await server.call("DELETE", `/api/years/2025/documents/${documents[0]!.id}`, { as: OWNER, body: { revision } })).status).toBe(200);
}
