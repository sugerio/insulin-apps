import "./setup.ts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Estimate, Person, SlipList, TaxYear } from "#shared";
import type { SlipReader } from "../../src/app/server/lib/reader.ts";
import { OWNER, type TestServer } from "../support/server.ts";
import { clickWhenEnabled, holdRequests, pageSave, renderApp } from "./support.tsx";

// The requests of Income, Deductions and Credits: a save, an upload in a card, a slip saved in its card. The form starts
// again whenever the year changes, so what a request does to the page mustn't depend on the form that sent it.

/** Alex alone, single, in Ontario, step 1 saved; with a T4 when asked. */
async function seed(server: TestServer, { slip = false } = {}) {
  const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
  const year = (await (
    await server.call("PUT", "/api/years/2025/personal-info", {
      as: OWNER,
      body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] },
    })
  ).json()) as TaxYear;
  if (slip) {
    await server.call("POST", "/api/years/2025/slips", {
      as: OWNER,
      body: { revision: year.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } },
    });
  }
}

const answersOf = async (server: TestServer) => Object.values(((await (await server.call("GET", "/api/years/2025/estimate")).json()) as Estimate).input.answers)[0] ?? {};
const rents = () => screen.getByLabelText("Rents received") as HTMLInputElement;

describe("a step's requests", () => {
  it("locks the form while a slip saved in its card is sent, and keeps what was typed", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s, { slip: true }) });
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Rental income" }));
    fireEvent.change(rents(), { target: { value: "1000" } });
    const onReturn = screen.getByRole("region", { name: "On your return" });
    fireEvent.change(within(onReturn).getByLabelText(/^Box 22/), { target: { value: "9500" } });
    const held = holdRequests((method, path) => method !== "GET" && path.startsWith("/api/years/2025/"));
    fireEvent.click(within(onReturn).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.held()).toBe(1));
    // While it is sent, nothing in the form can change.
    expect(rents().disabled).toBe(true);
    for (const button of screen.getAllByRole("button", { name: /^Sav/ })) expect((button as HTMLButtonElement).disabled).toBe(true);
    held.release();
    await waitFor(() => expect(rents().disabled).toBe(false));
    expect(rents().value).toBe("1000");
    expect(await answersOf(server)).toMatchObject({ hasRentalIncome: true, rentalGross: "1000" });
  });

  it("keeps a save's lock and its answer when an upload on another step changes the year meanwhile", async () => {
    let read!: () => void;
    const reading = new Promise<void>((resolve) => (read = resolve));
    const late: SlipReader = {
      read: async () => {
        await reading;
        return { kind: "read", taxYear: 2025, model: "test-model", slips: [{ type: "T5", person: "Alex Martin", issuer: "Lakeview Credit Union", boxes: { 13: "1250" }, unsure: [] }] };
      },
    };
    const { router, server } = await renderApp("/returns/2025/upload", { seed: (s) => seed(s), server: { reader: () => late } });
    fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 late"], "T5.pdf", { type: "application/pdf" })] } });
    await act(() => router.navigate(router.state.location.pathname.replace(/upload$/, "income")));
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Rental income" }));
    fireEvent.change(rents(), { target: { value: "1000" } });
    const held = holdRequests((method, path) => method === "PUT" && path === "/api/years/2025/answers");
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(held.held()).toBe(1));

    // The upload finishes: the year changes, and the form starts again from it, still saving.
    read();
    expect(await screen.findByRole("link", { name: /Upload documents\s*\(done\)/ })).toBeTruthy();
    expect((await screen.findByLabelText("Rents received") as HTMLInputElement).disabled).toBe(true);
    expect(rents().value).toBe("1000");

    // The save was sent before the upload changed the year: it is refused, and the page says so.
    held.release();
    expect(await screen.findByText("Someone else changed this year")).toBeTruthy();
    expect(router.state.location.pathname).toMatch(/\/income$/);
    expect(rents().disabled).toBe(false);
    expect(rents().value).toBe("1000");
    expect(await answersOf(server)).not.toHaveProperty("rentalGross");
  });

  it("keeps a slip's typed boxes and why its save was refused when an upload on another step changes the year meanwhile", async () => {
    let read!: () => void;
    const reading = new Promise<void>((resolve) => (read = resolve));
    const late: SlipReader = {
      read: async () => {
        await reading;
        return { kind: "read", taxYear: 2025, model: "test-model", slips: [{ type: "T5", person: "Alex Martin", issuer: "Lakeview Credit Union", boxes: { 13: "1250" }, unsure: [] }] };
      },
    };
    const { router } = await renderApp("/returns/2025/upload", { seed: (s) => seed(s, { slip: true }), server: { reader: () => late } });
    fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 late"], "T5.pdf", { type: "application/pdf" })] } });
    await act(() => router.navigate(router.state.location.pathname.replace(/upload$/, "income")));
    const box22 = () => within(screen.getByRole("region", { name: "On your return" })).getByLabelText(/^Box 22/) as HTMLInputElement;
    await screen.findByRole("region", { name: "On your return" });
    fireEvent.change(box22(), { target: { value: "9500" } });
    const held = holdRequests((method, path) => method === "PATCH" && path.startsWith("/api/years/2025/slips/"));
    fireEvent.click(within(screen.getByRole("form", { name: "Edit T4 from Maple Corp" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.held()).toBe(1));

    // The upload finishes: the year changes, and the form starts again from it, the slip still open and saving.
    read();
    expect(await screen.findByRole("link", { name: /Upload documents\s*\(done\)/ })).toBeTruthy();
    await waitFor(() => expect(box22().disabled).toBe(true));
    expect(box22().value).toBe("9500");

    // The slip was sent before the upload changed the year: it is refused, and its form says so, keeping 9500.
    held.release();
    expect(await screen.findByText("Someone else changed this year since you opened it. Reload to see their changes.")).toBeTruthy();
    await waitFor(() => expect(box22().disabled).toBe(false));
    expect(box22().value).toBe("9500");
  });

  /** Rental income at 1000, then the T4's card given a file that isn't a PDF: the answers are saved first, then the file is refused. */
  async function refusedUpload() {
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Employment income" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Rental income" }));
    fireEvent.change(rents(), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Upload the T4"), { target: { files: [new File(["not a PDF at all"], "T4.pdf", { type: "application/pdf" })] } });
  }

  it("keeps a typed amount when the year is loaded again after someone else changed it, and saves it", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s) });
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Rental income" }));
    fireEvent.change(rents(), { target: { value: "1000" } });
    // Another tab adds a slip: the year moves on, the amount typed here doesn't.
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    const slip = { revision: year.revision, personId: year.adults[0]!.personId, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000" } };
    expect((await server.call("POST", "/api/years/2025/slips", { as: OWNER, body: slip })).status).toBe(201);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const banner = (await screen.findByText("Someone else changed this year")).closest<HTMLElement>("[role=alert]")!;
    const before = rents();
    fireEvent.click(within(banner).getByRole("button", { name: "Reload" }));
    // The newer year is here once the form starts again from it: a new field, still holding what was typed.
    await waitFor(() => expect(rents()).not.toBe(before));
    expect(screen.queryByText("Someone else changed this year")).toBeNull();
    expect(rents().value).toBe("1000");
    await clickWhenEnabled(pageSave);
    await waitFor(async () => expect(await answersOf(server)).toMatchObject({ hasRentalIncome: true, rentalGross: "1000" }));
  });

  it("stops showing why an amount was refused once it is changed, and keeps the other amounts' reasons", async () => {
    await renderApp("/returns/2025/income", { seed: (s) => seed(s) });
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Rental income" }));
    const expenses = () => screen.getByLabelText("Rental expenses") as HTMLInputElement;
    fireEvent.change(rents(), { target: { value: "12.345" } });
    fireEvent.change(expenses(), { target: { value: "1.234" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rents().getAttribute("aria-invalid")).toBe("true"));
    expect(expenses().getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(rents(), { target: { value: "1000" } });
    expect(rents().getAttribute("aria-invalid")).toBeNull();
    expect(within(rents().closest<HTMLElement>("div.flex-col")!).queryByText("Enter an amount like 1234.56")).toBeNull();
    expect(expenses().getAttribute("aria-invalid")).toBe("true");
    expect(within(expenses().closest<HTMLElement>("div.flex-col")!).getByText("Enter an amount like 1234.56")).toBeTruthy();
  });

  describe("a slip's box refused in its card", () => {
    const onReturn = () => screen.getByRole("region", { name: "On your return" });
    const box = (number: number) => within(onReturn()).getByLabelText(new RegExp(`^Box ${number} `)) as HTMLInputElement;
    const toggleT4 = () => fireEvent.click(within(onReturn()).getByRole("button", { name: "T4 from Maple Corp" }));
    const saveSlip = () => fireEvent.click(within(onReturn()).getByRole("button", { name: "Save" }));
    async function refused(boxes: Record<number, string>) {
      const rendered = await renderApp("/returns/2025/income", { seed: (s) => seed(s, { slip: true }) });
      await screen.findByRole("region", { name: "On your return" });
      for (const [number, amount] of Object.entries(boxes)) fireEvent.change(box(Number(number)), { target: { value: amount } });
      saveSlip();
      for (const number of Object.keys(boxes)) await waitFor(() => expect(box(Number(number)).getAttribute("aria-invalid")).toBe("true"));
      return rendered;
    }

    it("stays corrected when the step is saved and its form starts again", async () => {
      await refused({ 14: "2.345" });
      fireEvent.change(box(14), { target: { value: "2345" } });
      expect(box(14).getAttribute("aria-invalid")).toBeNull();
      // Saving the step moves the year on: the form starts again from what the page kept.
      fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Rental income" }));
      fireEvent.change(rents(), { target: { value: "1000" } });
      const before = box(14);
      fireEvent.click(screen.getAllByRole("button", { name: "Save" }).find((button) => !onReturn().contains(button))!);
      await waitFor(() => expect(box(14)).not.toBe(before));
      expect(box(14).value).toBe("2345");
      expect(box(14).getAttribute("aria-invalid")).toBeNull();
    });

    it("stays corrected when the slip is closed and opened again, and the other box still says why", async () => {
      await refused({ 14: "2.345", 22: "1.234" });
      fireEvent.change(box(22), { target: { value: "9500" } });
      toggleT4();
      toggleT4();
      expect(box(22).value).toBe("9500");
      expect(box(22).getAttribute("aria-invalid")).toBeNull();
      expect(box(14).getAttribute("aria-invalid")).toBe("true");
    });

    it("still says why when the slip is closed and opened again without a change", async () => {
      await refused({ 14: "2.345", 22: "1.234" });
      toggleT4();
      toggleT4();
      for (const number of [14, 22]) {
        expect(box(number).getAttribute("aria-invalid")).toBe("true");
        expect(within(box(number).closest("tr")!).getByText("Enter an amount like 1234.56")).toBeTruthy();
      }
    });

    it("still says why on a slip being added when the step is saved and its form starts again", async () => {
      await renderApp("/returns/2025/income", { seed: (s) => seed(s) });
      fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Employment income" }));
      fireEvent.click(screen.getByRole("button", { name: "Enter the T4" }));
      const form = () => screen.getByRole("form", { name: "Add a slip" });
      const newBox = (number: number) => within(form()).getByLabelText(new RegExp(`^Box ${number} `)) as HTMLInputElement;
      fireEvent.change(within(form()).getByLabelText("Issued by"), { target: { value: "Maple Corp" } });
      fireEvent.change(newBox(14), { target: { value: "2.345" } });
      fireEvent.change(newBox(22), { target: { value: "1.234" } });
      fireEvent.click(within(form()).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(newBox(22).getAttribute("aria-invalid")).toBe("true"));
      const before = newBox(14);
      await clickWhenEnabled(() => screen.getAllByRole("button", { name: "Save" }).find((button) => !form().contains(button))!);
      await waitFor(() => expect(newBox(14)).not.toBe(before));
      for (const number of [14, 22]) expect(newBox(number).getAttribute("aria-invalid")).toBe("true");
    });

    it("drops its refusal when someone else saves the slip meanwhile, and says so", async () => {
      const { server } = await refused({ 14: "2.345" });
      const { slips } = (await (await server.call("GET", "/api/years/2025/slips")).json()) as { slips: { id: string; boxes: Record<string, string> }[] };
      const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
      const elsewhere = await server.call("PATCH", `/api/years/2025/slips/${slips[0]!.id}`, { as: OWNER, body: { revision: year.revision, boxes: { ...slips[0]!.boxes, 14: "70000" } } });
      expect(elsewhere.status).toBe(200);
      // This page learns of it from a 409 and Reload: the step's Save sends the slip's corrected boxes first.
      fireEvent.change(box(14), { target: { value: "2345" } });
      fireEvent.click(screen.getAllByRole("button", { name: "Save" }).find((button) => !onReturn().contains(button))!);
      const banner = (await screen.findByText("Someone else changed this year")).closest<HTMLElement>("[role=alert]")!;
      fireEvent.click(within(banner).getByRole("button", { name: "Reload" }));
      // The form starts again from the stored slip; the refusal of what was typed over the old one goes with it.
      // (The region is looked up again each time: the reload replaces it.)
      await waitFor(() => expect(within(onReturn()).getByText(/Someone else changed this slip while you were changing it/)).toBeTruthy());
      expect(box(14).value).toBe("70000");
      expect(box(14).getAttribute("aria-invalid")).toBeNull();
      expect(within(box(14).closest("tr")!).queryByText("Enter an amount like 1234.56")).toBeNull();
    });

    it("says why again when a corrected box is refused on the next save", async () => {
      await refused({ 14: "2.345" });
      fireEvent.change(box(14), { target: { value: "3.456" } });
      expect(box(14).getAttribute("aria-invalid")).toBeNull();
      await clickWhenEnabled(() => within(onReturn()).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(box(14).getAttribute("aria-invalid")).toBe("true"));
      expect(within(box(14).closest("tr")!).getByText("Enter an amount like 1234.56")).toBeTruthy();
    });
  });

  it("saves a slip changed in its open form with the step, and confirms it on Save and continue", async () => {
    const { server, router } = await renderApp("/returns/2025/income", { seed: (s) => seed(s, { slip: true }) });
    const onReturn = await screen.findByRole("region", { name: "On your return" });
    fireEvent.change(within(onReturn).getByLabelText(/^Box 22/), { target: { value: "9500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/deductions$/));
    const { slips } = (await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList;
    expect(slips.map((slip) => [slip.boxes[22], slip.status])).toEqual([["9500", "confirmed"]]);
  });

  it("stays on the step when a choice isn't made, marks it and goes to it; the banner goes there too", async () => {
    const { server, router } = await renderApp("/returns/2025/income", { seed: (s) => seed(s) });
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Self-employment or business income" }));
    fireEvent.change(screen.getByLabelText("Gross income"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    const kind = () => screen.getByLabelText("Kind of income") as HTMLSelectElement;
    await waitFor(() => expect(kind().getAttribute("aria-invalid")).toBe("true"));
    expect(within(kind().parentElement!.parentElement!).getByText("Choose one to finish this step.")).toBeTruthy();
    expect(document.activeElement).toBe(kind());
    expect(router.state.location.pathname).toMatch(/\/income$/);
    // What was entered is saved all the same.
    expect(await answersOf(server)).toMatchObject({ hasSelfEmployment: true, selfEmploymentGross: "5000" });
    // The banner names it, and goes to it.
    (document.activeElement as HTMLElement).blur();
    const banner = screen.getByText("To finish this step").closest<HTMLElement>("[role=status]")!;
    fireEvent.click(within(banner).getByRole("button", { name: "Kind of income" }));
    expect(document.activeElement).toBe(kind());
    // Chosen, it is no longer marked.
    fireEvent.change(kind(), { target: { value: "business" } });
    expect(kind().getAttribute("aria-invalid")).toBeNull();
  });

  it("removes one slip, its file kept, and a kind of income with its slips once agreed", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s, { slip: true }) });
    const onReturn = () => screen.getByRole("region", { name: "On your return" });
    await screen.findByRole("region", { name: "On your return" });
    // The card asks first: it removes the slip too.
    fireEvent.click(within(onReturn()).getByRole("button", { name: "Remove Employment income" }));
    const ask = within(onReturn()).getByRole("group", { name: "Remove Employment income?" });
    expect(ask.textContent).toMatch(/This also removes its slip\. Your files stay on Upload\./);
    fireEvent.click(within(ask).getByRole("button", { name: "Keep" }));
    expect(within(onReturn()).getByRole("button", { name: "T4 from Maple Corp" })).toBeTruthy();
    fireEvent.click(within(onReturn()).getByRole("button", { name: "Remove Employment income" }));
    fireEvent.click(within(onReturn()).getByRole("button", { name: "Remove with its slip" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Employment income" })).toBeTruthy());
    expect(((await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList).slips).toEqual([]);
    expect(await answersOf(server)).toMatchObject({ hasEmploymentIncome: false });
  });

  it("removes a slip from its card, and the card then waits for one", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s, { slip: true }) });
    fireEvent.click(within(await screen.findByRole("region", { name: "On your return" })).getByRole("button", { name: "Remove T4 from Maple Corp" }));
    expect(await screen.findByText("No T4 yet. Upload it, or enter its boxes.")).toBeTruthy();
    expect(((await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList).slips).toEqual([]);
  });

  it("says why an upload in a card was refused", async () => {
    await renderApp("/returns/2025/income", { seed: (s) => seed(s) });
    await refusedUpload();
    const refused = (await screen.findByText("The file isn't a PDF")).closest<HTMLElement>("[role=alert]")!;
    expect(within(refused).getByText("The content doesn't match its type")).toBeTruthy();
    expect(rents().value).toBe("1000");
  });

  it("takes the year the answers were saved under when the upload after them is refused", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s) });
    await refusedUpload();
    await waitFor(async () => expect(await answersOf(server)).toMatchObject({ rentalGross: "1000" }));
    await waitFor(() => expect(rents().disabled).toBe(false));
    fireEvent.change(rents(), { target: { value: "1200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await answersOf(server)).toMatchObject({ rentalGross: "1200" }));
    expect(screen.queryByText("Someone else changed this year")).toBeNull();
  });
});
