import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import { OWNER, VIEWER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

/** A married couple in Ontario, $60,000 each on a T4 and $150 of donations each: pooling saves $20.60. */
async function seed(server: TestServer): Promise<Person> {
  const add = async (name: string, relationship: string) =>
    (await (await server.call("POST", "/api/people", { as: OWNER, body: { name, relationship, birthDate: "1985-04-02" } })).json()) as Person;
  const alex = await add("Alex Martin", "self");
  const sam = await add("Sam Martin", "spouse");
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id, sam.id] } });
  let year = (await (
    await server.call("PUT", "/api/years/2025/personal-info", {
      as: OWNER,
      body: { revision: 1, maritalStatus: "married", adults: [alex, sam].map((person) => ({ personId: person.id, province: "ON", residentAllYear: true })) },
    })
  ).json()) as TaxYear;
  for (const person of [alex, sam]) {
    year = (await (
      await server.call("POST", "/api/years/2025/slips", { as: OWNER, body: { revision: year.revision, personId: person.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } } })
    ).json()) as TaxYear;
    year = (await (await server.call("PUT", "/api/years/2025/answers", { as: OWNER, body: { revision: year.revision, personId: person.id, answers: { donations: "150" } } })).json()) as TaxYear;
  }
  return alex;
}

const answersOf = async (server: TestServer, personId: string) => ((await (await server.call("GET", "/api/years/2025/estimate")).json()) as Estimate).input.answers[personId];

describe("hints on Finish", () => {
  it("apply a saving, show it applied, and undo it", async () => {
    let alex: Person | undefined;
    const { server } = await renderApp("/returns/2025/finish", { seed: async (s) => void (alex = await seed(s)) });
    const hints = await screen.findByRole("list", { name: "Hints" });
    const pool = within(hints).getByRole("listitem", { name: "Claim both spouses' donations on one return" });
    expect(within(pool).getByText("Saves $20.60")).toBeTruthy();
    expect(within(pool).getByText("$150.00")).toBeTruthy();

    fireEvent.click(within(pool).getByRole("button", { name: "Apply: Claim both spouses' donations on one return" }));
    await waitFor(() => expect(screen.getByText("Saved $20.60")).toBeTruthy());
    expect(await answersOf(server, alex!.id)).toMatchObject({ claimSpouseDonations: true });

    fireEvent.click(screen.getByRole("button", { name: "Undo: Claim both spouses' donations on one return" }));
    await waitFor(() => expect(screen.getByText("Saves $20.60")).toBeTruthy());
    expect(await answersOf(server, alex!.id)).toEqual({ donations: "150" });
  });

  it("dismiss a hint and show it again", async () => {
    await renderApp("/returns/2025/finish", { seed: async (s) => void (await seed(s)) });
    const hints = await screen.findByRole("list", { name: "Hints" });
    fireEvent.click(within(hints).getByRole("button", { name: "Dismiss: Interest is taxable even without a T5" }));
    const dismissed = await screen.findByRole("region", { name: "Dismissed hints" });
    expect(within(dismissed).getByText("Interest is taxable even without a T5")).toBeTruthy();
    fireEvent.click(within(dismissed).getByRole("button", { name: "Show again: Interest is taxable even without a T5" }));
    // The hints load again with the year: the reminder is back in the list, and nothing is dismissed.
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Hints" })).getByRole("listitem", { name: "Interest is taxable even without a T5" })).toBeTruthy());
    expect(screen.queryByRole("region", { name: "Dismissed hints" })).toBeNull();
  });

  it("show a viewer the hints without the buttons", async () => {
    await renderApp("/returns/2025/finish", { as: VIEWER, seed: async (s) => void (await seed(s)) });
    const hints = await screen.findByRole("list", { name: "Hints" });
    expect(within(hints).getByText("Saves $20.60")).toBeTruthy();
    expect(within(hints).queryByRole("button")).toBeNull();
  });
});
