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
    answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" },
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
    expect(screen.getByText(/Filing status\./).closest("p")?.textContent).toMatch(/A married couple chooses: jointly, one return with both incomes/);
  });

  it("shows the federal refund, and offers the IRS's forms to download", async () => {
    let alex: Person | undefined;
    const { router } = await renderApp("/returns", { seed: async (s) => void (alex = await seedFinishedUs(s)) });
    await screen.findByText("United States. File by April 15, 2026.");
    await router.navigate(`/returns/2025/${alex!.id}/finish`);
    const results = await screen.findByRole("list", { name: "Key lines" });
    expect(screen.getByText("Refund").nextElementSibling?.textContent).toBe("$825.00");
    expect(within(results).getByText("Tax")).toBeTruthy();
    const forms = screen.getByRole("region", { name: "Your forms" });
    expect(forms.textContent).toMatch(/Form 1040 and the schedules and forms your return uses/);
    expect(forms.textContent).toMatch(/mail it to the IRS/);
    expect(forms.textContent).not.toMatch(/CRA|NETFILE/);
    expect((within(forms).getByRole("button", { name: "Download the forms (PDF)" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/** Alex and Sam, married, both in a US 2025 year; with `joint`, filing jointly. */
async function seedCouple(server: TestServer, joint: boolean) {
  const add = async (name: string, relationship: string, birthDate: string) =>
    (await (await server.call("POST", "/api/people", { body: { name, relationship, birthDate } })).json()) as Person;
  const alex = await add("Alex Rivera", "self", "1984-02-02");
  const sam = await add("Sam Rivera", "spouse", "1986-06-06");
  const year = (await (await server.call("POST", "/api/years", { body: { year: 2025, country: "us", people: [alex.id, sam.id] } })).json()) as TaxYear;
  if (joint) {
    await server.call("PUT", "/api/years/2025/personal-info", {
      body: {
        revision: year.revision,
        maritalStatus: "married",
        filingStatus: "joint",
        adults: [alex, sam].map((person) => ({ personId: person.id, province: null, residentAllYear: true })),
      },
    });
  }
  return { alex, sam };
}

describe("a joint return in the browser", () => {
  it("is chosen on Personal info, and then asks about both spouses", async () => {
    const { server } = await renderApp("/returns/2025", { seed: async (s) => void (await seedCouple(s, false)) });
    await screen.findByRole("heading", { name: "Personal info" });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Marital status on December 31, 2025" })).getByRole("radio", { name: "Married" }));
    const filing = screen.getByRole("radiogroup", { name: "Filing status" });
    fireEvent.click(within(filing).getByRole("radio", { name: "Married filing jointly" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "A U.S. citizen or resident alien all year?" })).getByRole("radio", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).filingStatus).toBe("joint"));
    // The spouse's card: their residency, and the questions about them, in their name.
    const theirs = (await screen.findByRole("heading", { name: "Where you lived: Sam Rivera" })).closest<HTMLElement>("[data-slot=card]")!;
    expect(within(theirs).getByRole("radiogroup", { name: "A U.S. citizen or resident alien all year?" })).toBeTruthy();
    expect(await within(theirs).findByText("Sam Rivera is blind")).toBeTruthy();
    expect(within(theirs).getByText("Someone can claim Sam Rivera as a dependent")).toBeTruthy();
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    expect(year.returns).toHaveLength(1);
  });

  it("asks whose income, and keeps each spouse's W-2 as theirs", async () => {
    let couple: { alex: Person; sam: Person } | undefined;
    const { router, server } = await renderApp("/returns", { seed: async (s) => void (couple = await seedCouple(s, true)) });
    await screen.findByText("United States. File by April 15, 2026.");
    expect(screen.getByRole("list", { name: "2025 returns" }).querySelectorAll(":scope > li")).toHaveLength(1);
    // Sam's own address opens the joint return, at the same step.
    await router.navigate(`/returns/2025/${couple!.sam.id}/income`);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/returns/2025/${couple!.alex.id}/income`));
    const whose = await screen.findByRole("radiogroup", { name: "Whose income?" });
    fireEvent.click(within(whose).getByRole("radio", { name: "Sam Rivera" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Wages from an employer" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter the W-2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Issued by" }), { target: { value: "Initech" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Box 1 Wages, tips, other compensation" }), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(async () => {
      const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as { slips: { personId: string; issuer: string }[] };
      expect(slips.slips.map((slip) => [slip.personId, slip.issuer])).toEqual([[couple!.sam.id, "Initech"]]);
    });
  });
});

describe("dependants in the browser", () => {
  it("asks about each dependant on Personal info, and shows the child tax credit and the care credit on Finish", async () => {
    let ids: { alex: string; ava: string } | undefined;
    const { router, server } = await renderApp("/returns", {
      seed: async (s) => {
        const add = async (name: string, relationship: string, birthDate: string) =>
          (await (await s.call("POST", "/api/people", { body: { name, relationship, birthDate } })).json()) as Person;
        const alex = await add("Alex Rivera", "self", "1985-02-02");
        const ava = await add("Ava Rivera", "child", "2017-05-05");
        ids = { alex: alex.id, ava: ava.id };
        const call = async (method: string, path: string, body: object) => (await (await s.call(method, path, { body })).json()) as TaxYear;
        let year = await call("POST", "/api/years", { year: 2025, country: "us", people: [alex.id, ava.id] });
        year = await call("PUT", "/api/years/2025/personal-info", { revision: year.revision, maritalStatus: "single", adults: [{ personId: alex.id, province: null, residentAllYear: true }] });
        year = await call("POST", "/api/years/2025/slips", {
          revision: year.revision,
          personId: alex.id,
          type: "W2",
          issuer: "City Clinic",
          boxes: { 1: "58000", 2: "1500", 4: "3596", 5: "58000", 6: "841" },
        });
        await call("PUT", "/api/years/2025/answers", {
          revision: year.revision,
          personId: alex.id,
          answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0", paidHalfOfHome: true, hasValidSSN: true },
        });
      },
    });
    await screen.findByText("United States. File by April 15, 2026.");
    await router.navigate(`/returns/2025/${ids!.alex}/personal`);
    const card = (await screen.findByRole("heading", { name: "Dependant: Ava Rivera" })).closest<HTMLElement>("[data-slot=card]")!;
    const relationship = within(card).getByRole("combobox", { name: "Their relationship to you" }) as HTMLSelectElement;
    expect([...relationship.options].map((option) => option.textContent)).toContain("Son, daughter, stepchild or adopted child");
    fireEvent.change(relationship, { target: { value: "child" } });
    fireEvent.change(within(card).getByRole("textbox", { name: "Months they lived with you in 2025" }), { target: { value: "12" } });
    // The rest of the child's questions, once the relationship and months are saved, appear with them.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const estimate = (await (await server.call("GET", "/api/years/2025/estimate")).json()) as { input: { family: { dependants: { answers?: Record<string, unknown> }[] } } };
      expect(estimate.input.family.dependants[0]!.answers).toMatchObject({ relationship: "child", monthsWithYou: "12" });
    });
    // The rest of the child's questions appear once the relationship and months are saved: answer them on the page.
    const again = (await screen.findByRole("heading", { name: "Dependant: Ava Rivera" })).closest<HTMLElement>("[data-slot=card]")!;
    const answer = (question: string, choice: "Yes" | "No") =>
      fireEvent.click(within(within(again).getByRole("radiogroup", { name: question })).getByRole("radio", { name: choice }));
    await within(again).findByRole("radiogroup", { name: "Has a social security number valid for employment" });
    answer("Has a social security number valid for employment", "Yes");
    answer("Paid over half of their own support in 2025", "No");
    answer("Files a joint return for 2025", "No");
    answer("A U.S. citizen, U.S. national or U.S. resident alien", "Yes");
    // A child who lived with you: whether you paid for care so you could work.
    const yes = (question: string, choice: "Yes" | "No") =>
      fireEvent.click(within(screen.getByRole("radiogroup", { name: question })).getByRole("radio", { name: choice }));
    yes("You paid for the care of a child under 13, or of a dependant who can't care for themselves, so you could work", "Yes");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const estimate = (await (await server.call("GET", "/api/years/2025/estimate")).json()) as { input: { family: { dependants: { answers?: Record<string, unknown> }[] } } };
      expect(estimate.input.family.dependants[0]!.answers).toMatchObject({ hasSSN: true, citizenOrResident: true });
    });
    // Then the care paid for the child, on the child's card, and two questions about you.
    const child = (await screen.findByRole("heading", { name: "Dependant: Ava Rivera" })).closest<HTMLElement>("[data-slot=card]")!;
    fireEvent.change(await within(child).findByRole("textbox", { name: "Care you paid for them in 2025 so you could work" }), { target: { value: "4000" } });
    yes("You paid a household employee, such as a nanny, $2,800 or more in 2025, or $1,000 or more in a calendar quarter of 2024 or 2025", "No");
    yes("You paid in 2025 for care given in 2024", "No");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const estimate = (await (await server.call("GET", "/api/years/2025/estimate")).json()) as { input: { family: { dependants: { answers?: Record<string, unknown> }[] } } };
      expect(estimate.input.family.dependants[0]!.answers).toMatchObject({ careExpenses: "4000" });
    });
    await router.navigate(`/returns/2025/${ids!.alex}/finish?r=1`);
    const keyLines = await screen.findByRole("list", { name: "Key lines" });
    expect(within(keyLines).getByText("Child tax credit and credit for other dependents").closest("li")?.textContent).toMatch(/\$2,200\.00/);
    // 20% of $3,000 at $58,000 of AGI.
    expect(within(keyLines).getByText("Credit for child and dependent care expenses").closest("li")?.textContent).toMatch(/\$600\.00/);
  });
});
