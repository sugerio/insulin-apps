import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Person, TaxYear } from "#shared";
import type { TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

// A United States year in the browser: chosen when the year is started, asked without a province, worked out with the
// US rules, and not printed yet.

async function seedAlex(server: TestServer): Promise<Person> {
  const response = await server.call("POST", "/api/people", { body: { name: "Alex Rivera", relationship: "self", birthDate: "1991-03-03" } });
  return (await response.json()) as Person;
}

/** A finished US 2025 return: single, one W-2, every question answered and the slip confirmed. */
async function seedFinishedUs(server: TestServer) {
  const alex = await seedAlex(server);
  const call = async (method: string, path: string, body: object) => (await (await server.call(method, path, { body })).json()) as TaxYear;
  let year = await call("POST", "/api/years", { year: 2025, country: "us", people: [alex.id] });
  year = await call("PUT", "/api/years/2025/personal-info", { revision: year.revision, maritalStatus: "single", adults: [{ personId: alex.id, province: null, residentAllYear: true }] });
  year = await call("POST", "/api/years/2025/slips", { revision: year.revision, personId: alex.id, type: "W2", issuer: "Acme Tools", boxes: { 1: "40000", 2: "3500", 4: "2480", 5: "40000", 6: "580" } });
  year = await call("PUT", "/api/years/2025/answers", {
    revision: year.revision,
    personId: alex.id,
    answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" },
  });
  await call("POST", "/api/years/2025/slips/confirm", { revision: year.revision });
  return alex;
}

describe("a United States year", () => {
  it("is chosen when the year is started", async () => {
    const { router, server } = await renderApp("/returns", { seed: async (s) => void (await seedAlex(s)) });
    fireEvent.click(await screen.findByRole("button", { name: "Start 2025" }));
    const choice = screen.getByRole("radiogroup", { name: "Which country's return?" });
    expect(within(choice).getByRole("radio", { name: "Canada" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(choice).getByRole("radio", { name: "United States" }));
    expect(screen.getByText("United States. File by April 15, 2026.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a new person" }).getAttribute("href")).toBe(`/profile?back=${encodeURIComponent("/returns?start=2025&country=us")}`);
    fireEvent.click(screen.getByRole("button", { name: "Start 2025" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/personal$/));
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    expect(year.country).toBe("us");
  });

  it("asks about residency without a province, in the US's words", async () => {
    await renderApp("/returns/2025", {
      seed: async (s) => {
        const alex = await seedAlex(s);
        await s.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id] } });
      },
    });
    expect(await screen.findByRole("heading", { name: "Personal info" })).toBeTruthy();
    expect(screen.queryByLabelText("Province on December 31")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "A U.S. citizen or resident alien all year?" })).toBeTruthy();
    const statuses = screen.getByRole("radiogroup", { name: "Marital status on December 31, 2025" });
    expect(within(statuses).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(["Single", "Widowed", "Divorced", "Legally separated"]);
    expect(screen.getByText(/Filing status\./).closest("p")?.textContent).toMatch(/Married files separately/);
  });

  it("shows the federal refund, and says the forms can't be printed yet", async () => {
    let alex: Person | undefined;
    const { router } = await renderApp("/returns", { seed: async (s) => void (alex = await seedFinishedUs(s)) });
    await screen.findByText("United States. File by April 15, 2026.");
    await router.navigate(`/returns/2025/${alex!.id}/finish`);
    const results = await screen.findByRole("list", { name: "Key lines" });
    expect(screen.getByText("Refund").nextElementSibling?.textContent).toBe("$825.00");
    expect(within(results).getByText("Tax")).toBeTruthy();
    const forms = screen.getByRole("region", { name: "Your forms" });
    expect(forms.textContent).toMatch(/Printing this return on the official forms comes in a later version/);
    expect(screen.queryByRole("button", { name: /Open the forms/ })).toBeNull();
  });
});
