import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Person, TaxYear } from "#shared";
import type { TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

// A United States year in the browser: chosen when the year is started, asked the state instead of a province, worked
// out with the US rules, and printed on the IRS's forms.

async function seedAlex(server: TestServer): Promise<Person> {
  const response = await server.call("POST", "/api/people", { body: { name: "Alex Rivera", relationship: "self", birthDate: "1991-03-03" } });
  return (await response.json()) as Person;
}

/** A finished US 2025 return: single, one W-2, every question answered and the slip confirmed. */
async function seedFinishedUs(server: TestServer) {
  const alex = await seedAlex(server);
  const call = async (method: string, path: string, body: object) => (await (await server.call(method, path, { body })).json()) as TaxYear;
  let year = await call("POST", "/api/years", { year: 2025, country: "us", people: [alex.id] });
  year = await call("PUT", "/api/years/2025/personal-info", { revision: year.revision, maritalStatus: "single", adults: [{ personId: alex.id, province: "FL", residentAllYear: true }] });
  year = await call("POST", "/api/years/2025/slips", { revision: year.revision, personId: alex.id, type: "W2", issuer: "Acme Tools", boxes: { 1: "40000", 2: "3500", 4: "2480", 5: "40000", 6: "580" } });
  year = await call("PUT", "/api/years/2025/answers", {
    revision: year.revision,
    personId: alex.id,
    answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasDividends: false, hasBrokerSales: false, hasLossCarryover: false, hasIraDistribution: false, hasPension: false, hasSocialSecurity: false, hasOtherIncome: false, hasHsa: false, hasIraContribution: false, hasItemized: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0" },
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
    // The state: California's and New York's returns are prepared too; another state's says where to file it, or that
    // it has none.
    const state = screen.getByLabelText("State on December 31") as HTMLSelectElement;
    expect(within(state).getByRole("group", { name: "State return prepared here too" }).textContent).toBe("CaliforniaNew York");
    expect(within(state).getAllByRole("option")).toHaveLength(52);
    fireEvent.change(state, { target: { value: "NJ" } });
    expect(screen.getByText("Taxi prepares your federal return only. File your New Jersey return with other software.")).toBeTruthy();
    fireEvent.change(state, { target: { value: "TX" } });
    expect(screen.getByText("Texas has no state income tax return for wages and interest. Taxi prepares your federal return.")).toBeTruthy();
    fireEvent.change(state, { target: { value: "CA" } });
    expect(screen.queryByText(/Taxi prepares your federal return only/)).toBeNull();
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
        adults: [alex, sam].map((person) => ({ personId: person.id, province: "FL", residentAllYear: true })),
      },
    });
  }
  return { alex, sam };
}

describe("a joint return in the browser", () => {
  it("is chosen on Personal info; then each spouse's page asks about them alone", async () => {
    let couple: { alex: Person; sam: Person } | undefined;
    const { router, server } = await renderApp("/returns/2025", { seed: async (s) => void (couple = await seedCouple(s, false)) });
    await screen.findByRole("heading", { name: "Personal info" });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Marital status on December 31, 2025" })).getByRole("radio", { name: "Married" }));
    const filing = screen.getByRole("radiogroup", { name: "Filing status" });
    fireEvent.click(within(filing).getByRole("radio", { name: "Married filing jointly" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "A U.S. citizen or resident alien all year?" })).getByRole("radio", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).filingStatus).toBe("joint"));
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    expect(year.returns).toHaveLength(1);
    expect(year.returns[0]!.memberSteps.map((each) => each.personId)).toEqual([couple!.alex.id, couple!.sam.id]);
    // The person preparing's page has no card for the spouse: the spouse has their own page, from the switcher.
    expect(screen.queryByRole("heading", { name: "Where you lived: Sam Rivera" })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Return of Alex Rivera: switch return" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Sam Rivera/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/returns/2025/${couple!.sam.id}/personal`));
    expect(await screen.findByRole("button", { name: "Return of Sam Rivera: switch return" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "A U.S. citizen or resident alien all year?" })).toBeTruthy();
    expect(await screen.findByText("You are blind")).toBeTruthy();
  });

  it("shows each spouse's own income on their own page, with no choice of whose, and keeps each spouse's W-2 as theirs", async () => {
    let couple: { alex: Person; sam: Person } | undefined;
    const { router, server } = await renderApp("/returns", { seed: async (s) => void (couple = await seedCouple(s, true)) });
    await screen.findByText("United States. File by April 15, 2026.");
    expect(screen.getByRole("list", { name: "2025 returns" }).querySelectorAll(":scope > li")).toHaveLength(1);
    // Sam's own address opens Sam's part of the joint return.
    await router.navigate(`/returns/2025/${couple!.sam.id}/income`);
    await screen.findByRole("heading", { name: "Income" });
    expect(router.state.location.pathname).toBe(`/returns/2025/${couple!.sam.id}/income`);
    expect(screen.queryByRole("radiogroup", { name: "Whose income?" })).toBeNull();
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
        year = await call("PUT", "/api/years/2025/personal-info", { revision: year.revision, maritalStatus: "single", adults: [{ personId: alex.id, province: "FL", residentAllYear: true }] });
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
          answers: { hasWages: true, hasInterest: false, hasTipsOrOvertime: false, hasCarLoan: false, hasSelfEmployment: false, hasStudentLoan: false, paidForEducation: false, hasDividends: false, hasBrokerSales: false, hasLossCarryover: false, hasIraDistribution: false, hasPension: false, hasSocialSecurity: false, hasOtherIncome: false, hasHsa: false, hasIraContribution: false, hasItemized: false, canBeClaimed: false, isBlind: false, estimatedPayments: "0", paidHalfOfHome: true, hasValidSSN: true },
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

describe("US forms that start an amount", () => {
  it("offers a 1098-T's payments, less grants, as the start of your own education expenses on Personal info", async () => {
    let alexId = "";
    const { router, server } = await renderApp("/returns", {
      seed: async (s) => {
        const alex = await seedFinishedUs(s);
        alexId = alex.id;
        const call = async (method: string, path: string, body: object) => (await (await s.call(method, path, { body })).json()) as TaxYear;
        let year = (await (await s.call("GET", "/api/years/2025")).json()) as TaxYear;
        year = await call("POST", "/api/years/2025/slips", { revision: year.revision, personId: alex.id, type: "F1098T", issuer: "Valley College", boxes: { 1: "6000", 5: "1500" } });
        await call("PUT", "/api/years/2025/answers", { revision: year.revision, personId: alex.id, answers: { paidForEducation: true } });
      },
    });
    await screen.findByText("United States. File by April 15, 2026.");
    await router.navigate(`/returns/2025/${alexId}/personal`);
    const expenses = (await screen.findByRole("textbox", { name: "Your own qualified education expenses in 2025" })) as HTMLInputElement;
    expect(expenses.value).toBe("");
    expect(screen.getByText(/From your documents: \$4,500\.00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use $4,500.00" }));
    expect(expenses.value).toBe("4500");
    expect(screen.queryByRole("button", { name: "Use $4,500.00" })).toBeNull();
    // The credit is asked once there are expenses.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "The credit for your expenses" }), { target: { value: "llc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const estimate = (await (await server.call("GET", "/api/years/2025/estimate")).json()) as { input: { answers: Record<string, Record<string, unknown>> } };
      expect(estimate.input.answers[alexId]).toMatchObject({ educationExpenses: "4500", educationCredit: "llc" });
    });
  });
});
