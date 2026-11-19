import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import { OWNER, VIEWER, type TestServer } from "../support/server.ts";
import type { SlipReader } from "../../src/app/server/lib/reader.ts";
import { renderApp } from "./support.tsx";

/** Every yes/no question of the income, deductions and credits modules. */
const APPLIES = [
  "hasEmploymentIncome",
  "hasInvestmentIncome",
  "hasTrustIncome",
  "hasSoldInvestments",
  "hasOasPension",
  "hasCppBenefits",
  "hasPensionIncome",
  "hasRrifIncome",
  "hasEiBenefits",
  "hasSelfEmployment",
  "hasRentalIncome",
  "hasForeignIncome",
  "hasForeignProperty",
  "soldProperty",
  "hasWorkFromHome",
  "hasChildCare",
  "hasMovingExpenses",
  "hasTuition",
];

/** Alex alone, single, in Ontario, step 1 saved; optionally with What applies answered and a T4. */
async function seed(server: TestServer, { applies = false, slip = false } = {}) {
  const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
  let year = (await (
    await server.call("PUT", "/api/years/2025/household", {
      as: OWNER,
      body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] },
    })
  ).json()) as TaxYear;
  if (applies) {
    const answers = Object.fromEntries(APPLIES.map((id) => [id, false]));
    year = (await (await server.call("PUT", "/api/years/2025/answers", { as: OWNER, body: { revision: year.revision, personId: alex.id, answers } })).json()) as TaxYear;
  }
  if (slip) {
    await server.call("POST", "/api/years/2025/slips", {
      as: OWNER,
      body: { revision: year.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 16: "3361.75", 18: "984", 22: "9000" } },
    });
  }
  return alex;
}

/** Where a step of Alex's return is, once the old link to it has opened. */
const stepOf = (router: { state: { location: { pathname: string } } }, step: string) => router.state.location.pathname.replace(/[^/]+$/, step);

const estimate = async (server: TestServer) => (await (await server.call("GET", "/api/years/2025/estimate")).json()) as Estimate;

describe("a return", () => {
  it("opens from a link to a step without a person, as the person preparing's return", async () => {
    let alex: Person | undefined;
    // What applies became Income: an old link opens it.
    const { router } = await renderApp("/returns/2025/applies", { seed: async (s) => void (alex = await seed(s)) });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/returns/2025/${alex!.id}/income`));
    expect(await screen.findByText("Alex Martin", { selector: "span" })).toBeTruthy();
  });
});

describe("Personal info", () => {
  it("asks a spouse's net income when their return isn't prepared here", async () => {
    const { server } = await renderApp("/returns/2025/household", {
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/people", { as: OWNER, body: { name: "Sam Martin", relationship: "spouse", birthDate: "1987-09-15" } });
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await s.call("PUT", "/api/years/2025/household", {
          as: OWNER,
          body: { revision: 1, maritalStatus: "married", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] },
        });
      },
    });
    await screen.findByLabelText("Your spouse's or partner's 2025 net income");
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("Fill these in to continue")).toBeTruthy();
    // The save started the form again: the field is a new one.
    fireEvent.change(await screen.findByLabelText("Your spouse's or partner's 2025 net income"), { target: { value: "12,000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(async () => expect(Object.values((await estimate(server)).input.answers)[0]).toMatchObject({ spouseNetIncome: "12000" }));
  });
});

describe("Income", () => {
  it("shows the slips found on the return, each opening into its boxes, and what else can be added", async () => {
    await renderApp("/returns/2025/income", { seed: (s) => seed(s, { slip: true }).then(() => undefined) });
    const onReturn = await screen.findByRole("region", { name: "On your return" });
    expect(within(onReturn).getByRole("heading", { name: /Employment income/ })).toBeTruthy();
    // A kind of income its slips show can't be taken off here.
    expect(within(onReturn).queryByRole("button", { name: "Remove Employment income" })).toBeNull();
    const add = screen.getByRole("region", { name: "Add to your return" });
    expect(within(add).getByRole("button", { name: "Add Interest or dividends" })).toBeTruthy();
    expect(within(add).queryByRole("button", { name: "Add Employment income" })).toBeNull();
    expect(within(add).queryByRole("button", { name: /Add RRSP/ })).toBeNull();
    const row = within(onReturn).getByRole("button", { name: /T4 from Maple Corp/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect((within(onReturn).getByLabelText(/^Box 14/) as HTMLInputElement).value).toBe("60000");
    expect((within(onReturn).getByLabelText(/^Box 24/) as HTMLInputElement).value).toBe("");
    // Typed in, not read from a file: nothing to open.
    expect(within(onReturn).queryByRole("link", { name: "Open the original file" })).toBeNull();
    expect(within(onReturn).queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(row);
    expect(within(onReturn).queryByRole("table")).toBeNull();
  });

  it("changes a found slip's amounts right there, and keeps what was added", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s, { slip: true }).then(() => undefined) });
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Rental income" }));
    const onReturn = screen.getByRole("region", { name: "On your return" });
    fireEvent.click(within(onReturn).getByRole("button", { name: /T4 from Maple Corp/ }));
    fireEvent.change(within(onReturn).getByLabelText(/^Box 14/), { target: { value: "61,500.00" } });
    fireEvent.click(within(onReturn).getByRole("button", { name: "Cancel" }));
    expect((within(onReturn).getByLabelText(/^Box 14/) as HTMLInputElement).value).toBe("60000");
    fireEvent.change(within(onReturn).getByLabelText(/^Box 14/), { target: { value: "61,500.00" } });
    fireEvent.click(within(onReturn).getByRole("button", { name: "Save" }));
    // Saved: the slip stays open, with the new amount, to confirm again; rental income is still on the return.
    await waitFor(() => expect((within(screen.getByRole("region", { name: "On your return" })).getByLabelText(/^Box 14/) as HTMLInputElement).value).toBe("61500"));
    expect(within(screen.getByRole("region", { name: "On your return" })).getByRole("heading", { name: /Rental income/ })).toBeTruthy();
    const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as { slips: { boxes: Record<string, string>; status: string }[] };
    expect(slips.slips[0]).toMatchObject({ boxes: { 14: "61500", 16: "3361.75" }, status: "unconfirmed" });
    expect(Object.values((await estimate(server)).input.answers)[0]).toMatchObject({ hasRentalIncome: true });
  });

  it("shows a viewer the return's slips without anything to change or add", async () => {
    await renderApp("/returns/2025/income", { as: VIEWER, seed: (s) => seed(s, { slip: true }).then(() => undefined) });
    const onReturn = await screen.findByRole("region", { name: "On your return" });
    fireEvent.click(within(onReturn).getByRole("button", { name: /T4 from Maple Corp/ }));
    expect(within(onReturn).getByRole("table", { name: "T4 boxes" })).toBeTruthy();
    expect(within(onReturn).getByText("$60,000.00")).toBeTruthy();
    expect(within(onReturn).queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("region", { name: "Add to your return" })).toBeNull();
  });

  it("says at the top what is left before the step is done", async () => {
    await renderApp("/returns/2025/income", { seed: (s) => seed(s).then(() => undefined) });
    const banner = (await screen.findByText("To finish this step")).closest("[role=status]")!;
    expect(banner.textContent).toMatch(/Not answered yet: Employment income, Interest or dividends/);
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(screen.queryByText("To finish this step")).toBeNull());
  });

  it("marks a kind of income added without its slip as missing, and saves the rest as none", async () => {
    const { router, server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s).then(() => undefined) });
    const add = await screen.findByRole("region", { name: "Add to your return" });
    fireEvent.click(within(add).getByRole("button", { name: "Add Employment income" }));
    expect(screen.getByText("No T4 yet. Upload it, or enter its boxes.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save and continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Employment income" }));
    expect(screen.queryByText("No T4 yet. Upload it, or enter its boxes.")).toBeNull();
    // A group: its parts are asked in its card, and saved with it.
    fireEvent.click(within(screen.getByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Self-employment or business income" }));
    fireEvent.change(screen.getByLabelText("Kind of income"), { target: { value: "professional" } });
    fireEvent.change(screen.getByLabelText("Gross income"), { target: { value: "90,000" } });
    fireEvent.change(screen.getByLabelText("Business expenses"), { target: { value: "20000" } });
    const deductions = stepOf(router, "deductions");
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(deductions));
    const answers = Object.values((await estimate(server)).input.answers)[0]!;
    expect(answers).toMatchObject({
      hasSelfEmployment: true,
      selfEmploymentKind: "professional",
      selfEmploymentGross: "90000",
      selfEmploymentExpenses: "20000",
      hasEmploymentIncome: false,
      hasRentalIncome: false,
      soldProperty: false,
    });
    expect(answers).not.toHaveProperty("rentalGross");
  });

  it("enters a missing slip by hand right there, keeping what was added", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s).then(() => undefined) });
    const add = await screen.findByRole("region", { name: "Add to your return" });
    fireEvent.click(within(add).getByRole("button", { name: "Add Rental income" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Employment income" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter the T4" }));
    const form = screen.getByRole("form", { name: "Add a slip" });
    expect(within(form).queryByLabelText("Slip")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Issued by"), { target: { value: "Maple Corp" } });
    fireEvent.change(within(form).getByLabelText(/^Box 14/), { target: { value: "60,000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    // Saving the module, then the slip, starts the page again: query it afresh.
    await waitFor(() => expect(within(screen.getByRole("region", { name: "On your return" })).getByRole("button", { name: /T4 from Maple Corp/ })).toBeTruthy());
    expect(within(screen.getByRole("region", { name: "On your return" })).getByRole("heading", { name: /Rental income/ })).toBeTruthy();
    expect(screen.queryByText("No T4 yet. Upload it, or enter its boxes.")).toBeNull();
    const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as { slips: { type: string; boxes: Record<string, string> }[] };
    expect(slips.slips).toEqual([expect.objectContaining({ type: "T4", boxes: { 14: "60000" } })]);
  });

  it("takes the missing slip right there", async () => {
    const reader: SlipReader = {
      read: async () => ({ kind: "read", taxYear: 2025, model: "m", slips: [{ type: "T5", person: "Alex Martin", issuer: "Lakeview Credit Union", boxes: { 13: "1250.00" }, unsure: [] }] }),
    };
    await renderApp("/returns/2025/income", { seed: (s) => seed(s).then(() => undefined), server: { reader: () => reader } });
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: "Add Interest or dividends" }));
    fireEvent.change(screen.getByLabelText("Upload the T5"), { target: { files: [new File(["%PDF-1.4 t5"], "t5.pdf", { type: "application/pdf" })] } });
    // Saving the answers, the upload and reloading the year take a moment.
    await waitFor(() => expect(within(screen.getByRole("region", { name: "On your return" })).getByRole("button", { name: /T5 from Lakeview Credit Union/ })).toBeTruthy(), { timeout: 5000 });
    const onReturn = screen.getByRole("region", { name: "On your return" });
    fireEvent.click(within(onReturn).getByRole("button", { name: /T5 from Lakeview Credit Union/ }));
    expect(within(onReturn).getByRole("link", { name: "Open the original file" })).toBeTruthy();
  });
});

describe("Confirm", () => {
  it("adds a slip by hand from its boxes, and confirms it", async () => {
    const { server } = await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add a slip" }));
    const form = screen.getByRole("form", { name: "Add a slip" });
    fireEvent.change(within(form).getByLabelText("Issued by"), { target: { value: "Maple Corp" } });
    fireEvent.change(within(form).getByLabelText(/Box 14/), { target: { value: "60,000.00" } });
    fireEvent.change(within(form).getByLabelText(/Box 22/), { target: { value: "9000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("T4 · Maple Corp")).toBeTruthy();
    expect(screen.getByText("To confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 slip" }));
    expect(await screen.findByText("Confirmed")).toBeTruthy();
    expect((await estimate(server)).input.slips).toEqual([expect.objectContaining({ type: "T4", boxes: { 14: "60000", 22: "9000" } })]);
  });

  it("goes on to Finish, and shows months of study as months, not dollars", async () => {
    const { router } = await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add a slip" }));
    const form = screen.getByRole("form", { name: "Add a slip" });
    fireEvent.change(within(form).getByLabelText("Slip"), { target: { value: "T2202" } });
    fireEvent.change(within(form).getByLabelText("Issued by"), { target: { value: "Lakeshore College" } });
    fireEvent.change(within(form).getByLabelText(/Box 25/), { target: { value: "8" } });
    fireEvent.change(within(form).getByLabelText(/Box 26/), { target: { value: "6000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    const item = (await screen.findByText("T2202 · Lakeshore College")).closest("li")!;
    expect(item.textContent).toContain("Box 25 Number of months full-time: 8 · Box 26 Eligible tuition fees: $6,000.00");
    fireEvent.click(screen.getByRole("link", { name: "Next: finish" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/finish$/));
  });

  it("lists the boxes in the order printed", async () => {
    await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add a slip" }));
    const rows = within(screen.getByRole("form", { name: "Add a slip" })).getAllByRole("row").slice(1) as HTMLTableRowElement[];
    expect(rows.slice(0, 4).map((row) => row.cells[0]!.textContent)).toEqual(["14", "16", "16A", "18"]);
  });

  it("shows only the open return's slips, and moves one to the other adult's return", async () => {
    let ids: { alex: string; sam: string } | undefined;
    const { server } = await renderApp("/returns/2025/confirm", {
      seed: async (s) => {
        const add = async (name: string, relationship: string, birthDate: string) =>
          ((await (await s.call("POST", "/api/people", { as: OWNER, body: { name, relationship, birthDate } })).json()) as Person).id;
        const alex = await add("Alex Martin", "self", "1985-04-02");
        const sam = await add("Sam Martin", "spouse", "1987-09-15");
        ids = { alex, sam };
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex, sam] } });
        await s.call("POST", "/api/years/2025/slips", { as: OWNER, body: { revision: 1, personId: alex, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000" } } });
        await s.call("POST", "/api/years/2025/slips", { as: OWNER, body: { revision: 2, personId: sam, type: "T4", issuer: "Island Grocers", boxes: { 14: "31000" } } });
      },
    });
    expect(await screen.findByText("T4 · Maple Corp")).toBeTruthy();
    expect(screen.queryByText("T4 · Island Grocers")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move T4 from Maple Corp to Sam Martin's return" }));
    await waitFor(() => expect(screen.queryByText("T4 · Maple Corp")).toBeNull());
    const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as { slips: { personId: string; issuer: string }[] };
    expect(slips.slips.map((slip) => [slip.issuer, slip.personId]).sort()).toEqual([
      ["Island Grocers", ids!.sam],
      ["Maple Corp", ids!.sam],
    ]);
  });

  it("shows a viewer the slips without anything to change", async () => {
    await renderApp("/returns/2025/confirm", { as: VIEWER, seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    expect(await screen.findByText("T4 · Maple Corp")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a slip" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
  });
});

describe("Groups and notes", () => {
  it("asks a share used for work as a percent, and shows what else to file for foreign property", async () => {
    await renderApp("/returns/2025/deductions", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add Working from home" }));
    const share = screen.getByLabelText("Share used for work");
    expect(share.parentElement!.textContent).toContain("%");
    expect(screen.getByLabelText("Home expenses for 2025").parentElement!.textContent).toContain("$");
  });

  it("shows a note once a yes/no fact is added", async () => {
    await renderApp("/returns/2025/income", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add Property outside Canada that cost more than $100,000" }));
    expect(screen.getByText(/File Form T1135, Foreign Income Verification Statement/)).toBeTruthy();
    expect(screen.queryByText("Not handled yet")).toBeNull();
  });
});

describe("Deductions and credits", () => {
  it("shows what the slips already deduct, and saves what isn't on the return as none", async () => {
    const { router, server } = await renderApp("/returns/2025/deductions", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    const fromSlips = await screen.findByRole("region", { name: "From your slips" });
    expect(within(fromSlips).getByText("Deduction for CPP enhanced contributions on employment income")).toBeTruthy();
    const add = screen.getByRole("region", { name: "Add to your return" });
    expect(within(add).getByRole("button", { name: "Add Working from home" })).toBeTruthy();
    fireEvent.click(within(add).getByRole("button", { name: "Add RRSP contributions to deduct for 2025" }));
    fireEvent.change(screen.getByLabelText("RRSP contributions to deduct for 2025"), { target: { value: "2,500" } });
    const credits = stepOf(router, "credits");
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(credits));
    const answers = Object.values((await estimate(server)).input.answers)[0]!;
    expect(answers).toMatchObject({ rrspDeduction: "2500", fhsaDeduction: "0", hasWorkFromHome: false, hasMovingExpenses: false });
  });

  it("starts the RRSP deduction from the receipts, up to the limit on the notice of assessment", async () => {
    const { router, server } = await renderApp("/returns/2025/deductions", {
      seed: async (s) => {
        const alex = await seed(s, { applies: true });
        const add = async (type: string, issuer: string, boxes: Record<string, string>) => {
          const year = (await (await s.call("GET", "/api/years/2025", { as: OWNER })).json()) as TaxYear;
          await s.call("POST", "/api/years/2025/slips", { as: OWNER, body: { revision: year.revision, personId: alex.id, type, issuer, boxes } });
        };
        await add("RRSP", "Lakeview Credit Union", { 1: "4000" });
        await add("NOA", "Canada Revenue Agency", { 1: "3000" });
      },
    });
    const onReturn = await screen.findByRole("region", { name: "On your return" });
    expect(within(onReturn).getByRole("button", { name: /RRSP contribution receipt from Lakeview Credit Union/ })).toBeTruthy();
    expect((within(onReturn).getByLabelText("RRSP contributions to deduct for 2025") as HTMLInputElement).value).toBe("3000");
    expect(within(onReturn).getByText(/From your documents: \$3,000\.00/)).toBeTruthy();
    // A receipt's amounts have no box numbers.
    fireEvent.click(within(onReturn).getByRole("button", { name: /RRSP contribution receipt from/ }));
    expect(within(within(onReturn).getByRole("table")).queryByText("Box")).toBeNull();
    const credits = stepOf(router, "credits");
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(credits));
    expect(Object.values((await estimate(server)).input.answers)[0]).toMatchObject({ rrspDeduction: "3000" });
  });

  it("adds donation receipts to what is entered", async () => {
    await renderApp("/returns/2025/credits", {
      seed: async (s) => {
        const alex = await seed(s, { applies: true });
        const year = (await (await s.call("GET", "/api/years/2025", { as: OWNER })).json()) as TaxYear;
        await s.call("POST", "/api/years/2025/slips", { as: OWNER, body: { revision: year.revision, personId: alex.id, type: "DONATION", issuer: "Lakeview Food Bank", boxes: { 1: "450" } } });
      },
    });
    const onReturn = await screen.findByRole("region", { name: "On your return" });
    expect(within(onReturn).getByRole("heading", { name: /^Donations/ })).toBeTruthy();
    expect(within(onReturn).getByRole("button", { name: /Official donation receipt from Lakeview Food Bank/ })).toBeTruthy();
    expect(within(onReturn).getByLabelText("Not on an uploaded receipt")).toBeTruthy();
    expect(within(onReturn).queryByRole("button", { name: "Remove Donations" })).toBeNull();
  });

  it("asks only the credits the return reads", async () => {
    await renderApp("/returns/2025/credits", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    const add = await screen.findByRole("region", { name: "Add to your return" });
    expect(within(add).getByRole("button", { name: "Add Medical expenses" })).toBeTruthy();
    // Alex is single: nothing to transfer, and no spouse's income to ask.
    expect(within(add).queryByRole("button", { name: /Tuition to transfer/ })).toBeNull();
    expect(screen.queryByText(/spouse's or partner's 2025 net income/)).toBeNull();
    expect(within(screen.getByRole("region", { name: "From your slips" })).getByText("Canada employment amount")).toBeTruthy();
  });
});

describe("Finish", () => {
  it("shows the refund, the key lines with why, and what is left to check", async () => {
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    expect(await screen.findByText("Refund")).toBeTruthy();
    expect(screen.getByText("1 slip is not confirmed yet.")).toBeTruthy();
    expect(screen.getByText(/^Not answered yet: RRSP contributions/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Net federal tax/ }));
    expect(screen.getByText("= line.T1.40600")).toBeTruthy();
  });
});
