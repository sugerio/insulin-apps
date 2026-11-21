import "./setup.ts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import type { SlipReader } from "../../src/app/server/lib/reader.ts";
import { ORIGIN, OWNER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

// The requests of Income, Deductions and Credits: a save, an upload in a card, a slip saved in its card. The form starts
// again whenever the year changes, so what a request does to the page mustn't depend on the form that sent it.

/** Alex alone, single, in Ontario, step 1 saved; with a T4 when asked. */
async function seed(server: TestServer, { slip = false } = {}) {
  const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
  const year = (await (
    await server.call("PUT", "/api/years/2025/household", {
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

/**
 * Holds the page's requests that `match` before they reach the server, until released: what the page does meanwhile is
 * what a slow network shows. Call it after `renderApp`, which answers the page's requests.
 */
function holdRequests(match: (method: string, path: string) => boolean) {
  const send = globalThis.fetch;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
    if (match(init.method ?? "GET", url.pathname)) {
      held += 1;
      await released;
    }
    return send(input, init);
  });
  return { release, held: () => held };
}

const answersOf = async (server: TestServer) => Object.values(((await (await server.call("GET", "/api/years/2025/estimate")).json()) as Estimate).input.answers)[0] ?? {};
const rents = () => screen.getByLabelText("Rents received") as HTMLInputElement;

describe("a step's requests", () => {
  it("locks the form while a slip saved in its card is sent, and keeps what was typed", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s, { slip: true }) });
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Rental income" }));
    fireEvent.change(rents(), { target: { value: "1000" } });
    const onReturn = screen.getByRole("region", { name: "On your return" });
    fireEvent.click(within(onReturn).getByRole("button", { name: /T4 from Maple Corp/ }));
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
    fireEvent.click(within(await screen.findByRole("region", { name: "On your return" })).getByRole("button", { name: /T4 from Maple Corp/ }));
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
