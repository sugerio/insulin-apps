import "./setup.ts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Estimate, Person, SlipList, TaxYear } from "#shared";
import { OWNER, VIEWER, type TestServer } from "../support/server.ts";
import type { SlipReader } from "../../src/app/server/lib/reader.ts";
import { clickWhenEnabled, failRequestOnce, holdRequests, renderApp } from "./support.tsx";

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

/** Alex alone, single, in Ontario (or the province given), step 1 saved; optionally with What applies answered and a T4. */
async function seed(server: TestServer, { applies = false, slip = false, province = "ON" } = {}) {
  const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
  let year = (await (
    await server.call("PUT", "/api/years/2025/personal-info", {
      as: OWNER,
      body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province, residentAllYear: true }] },
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
    const { server } = await renderApp("/returns/2025/personal", {
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/people", { as: OWNER, body: { name: "Sam Martin", relationship: "spouse", birthDate: "1987-09-15" } });
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await s.call("PUT", "/api/years/2025/personal-info", {
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

  it("asks the days in Canada and the income while away of someone who moved during the year", async () => {
    const { server } = await renderApp("/returns/2025/personal", {
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await s.call("PUT", "/api/years/2025/personal-info", {
          as: OWNER,
          body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: false }] },
        });
      },
    });
    // A count of days, not dollars, up to the days of the year.
    const days = await screen.findByLabelText("Days you lived in Canada in 2025");
    expect(days.getAttribute("inputmode")).toBe("numeric");
    fireEvent.change(days, { target: { value: "400" } });
    expect(screen.getByText("Enter a whole number from 0 to 365")).toBeTruthy();
    fireEvent.change(days, { target: { value: "183" } });
    fireEvent.change(screen.getByLabelText("Your world income for the part of 2025 you didn't live in Canada"), { target: { value: "28,000" } });
    fireEvent.change(screen.getByLabelText("The part of it from Canada"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(async () =>
      expect(Object.values((await estimate(server)).input.answers)[0]).toMatchObject({ daysResident: "183", nonResidentIncome: "28000", nonResidentCanadianIncome: "0" }),
    );
  });

  it("asks whether a spouse who also moved lived in Canada on the same days, and if not their income on yours", async () => {
    let alex: Person | undefined;
    const { server } = await renderApp("/returns/2025/personal", {
      seed: async (s) => {
        alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        const sam = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Sam Martin", relationship: "spouse", birthDate: "1987-09-15" } })).json()) as Person;
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id, sam.id] } });
        const adults = [alex, sam].map((person) => ({ personId: person.id, province: "ON", residentAllYear: false }));
        let year = (await (await s.call("PUT", "/api/years/2025/personal-info", { as: OWNER, body: { revision: 1, maritalStatus: "married", adults } })).json()) as TaxYear;
        for (const person of [alex, sam]) {
          const answers = { daysResident: "100", nonResidentIncome: "20000", nonResidentCanadianIncome: "0" };
          year = (await (await s.call("PUT", "/api/years/2025/answers", { as: OWNER, body: { revision: year.revision, personId: person.id, answers } })).json()) as TaxYear;
        }
      },
    });
    const sameDays = await screen.findByRole("radiogroup", { name: "Did your spouse or partner live in Canada on the same days as you in 2025?" });
    expect(screen.getByRole("heading", { name: "Your spouse or partner" })).toBeTruthy();
    fireEvent.click(within(sameDays).getByRole("radio", { name: "No" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Not the same days: their income on Alex's days is asked next.
    const income = await screen.findByLabelText("Your spouse's or partner's net world income for the days you lived in Canada in 2025");
    fireEvent.change(income, { target: { value: "20,000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(async () =>
      expect((await estimate(server)).input.answers[alex!.id]).toMatchObject({ spouseSameDays: false, spouseIncomeWhileResident: "20000" }),
    );
  });

  it("clears an answer emptied here, so what is stored is what is shown", async () => {
    const { server } = await renderApp("/returns/2025/personal", {
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        const year = (await (
          await s.call("PUT", "/api/years/2025/personal-info", {
            as: OWNER,
            body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: false }] },
          })
        ).json()) as TaxYear;
        await s.call("PUT", "/api/years/2025/answers", { as: OWNER, body: { revision: year.revision, personId: alex.id, answers: { daysResident: "183" } } });
      },
    });
    const days = async () => (await screen.findByLabelText("Days you lived in Canada in 2025")) as HTMLInputElement;
    expect((await days()).value).toBe("183");
    fireEvent.change(await days(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(Object.values((await estimate(server)).input.answers)[0] ?? {}).not.toHaveProperty("daysResident"));
    expect((await days()).value).toBe("");
  });

  it("stops showing why an answer was refused once it is changed, and keeps the other answers' reasons", async () => {
    await renderApp("/returns/2025/personal", {
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await s.call("PUT", "/api/years/2025/personal-info", {
          as: OWNER,
          body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: false }] },
        });
      },
    });
    const DAYS = "Days you lived in Canada in 2025";
    const WORLD = "Your world income for the part of 2025 you didn't live in Canada";
    const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
    const reasonAt = (label: string, reason: string) => within(field(label).closest<HTMLElement>("div.flex-col")!).queryByText(reason);
    fireEvent.change(await screen.findByLabelText(DAYS), { target: { value: "366" } });
    fireEvent.change(field(WORLD), { target: { value: "12.345" } });
    await clickWhenEnabled(() => screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(field(WORLD).getAttribute("aria-invalid")).toBe("true"));
    expect(reasonAt(DAYS, "Enter a whole number from 0 to 365")).toBeTruthy();
    fireEvent.change(field(DAYS), { target: { value: "183" } });
    expect(field(DAYS).getAttribute("aria-invalid")).toBeNull();
    expect(reasonAt(DAYS, "Enter a whole number from 0 to 365")).toBeNull();
    expect(field(WORLD).getAttribute("aria-invalid")).toBe("true");
    expect(reasonAt(WORLD, "Enter an amount like 1234.56")).toBeTruthy();
  });

  it("shows a refused answer's reason at its field", async () => {
    await renderApp("/returns/2025/personal", {
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await s.call("PUT", "/api/years/2025/personal-info", {
          as: OWNER,
          body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: false }] },
        });
      },
    });
    fireEvent.change(await screen.findByLabelText("Days you lived in Canada in 2025"), { target: { value: "183.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The facts were saved, so the form starts again from the year they answered with, keeping what was typed.
    await waitFor(() => expect(screen.getByLabelText("Days you lived in Canada in 2025").getAttribute("aria-invalid")).toBe("true"));
    const days = screen.getByLabelText("Days you lived in Canada in 2025") as HTMLInputElement;
    expect(days.value).toBe("183.5");
    expect(within(days.closest("div.flex-col")!).getByText("Enter a whole number from 0 to 365")).toBeTruthy();
    // Every issue is at its field, so no banner repeats it.
    expect(screen.queryByText("Some answers don't fit their questions")).toBeNull();
  });

  it("locks the facts while they are saved, so nothing typed meanwhile is lost", async () => {
    await renderApp("/returns/2025/personal", {
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await s.call("PUT", "/api/years/2025/personal-info", {
          as: OWNER,
          body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: false }] },
        });
      },
    });
    const province = (await screen.findByLabelText("Province on December 31")) as HTMLSelectElement;
    const days = (await screen.findByLabelText("Days you lived in Canada in 2025")) as HTMLInputElement;
    fireEvent.change(province, { target: { value: "BC" } });
    fireEvent.change(days, { target: { value: "183" } });
    const held = holdRequests((method, path) => method === "PUT" && path.startsWith("/api/years/2025/"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.held()).toBe(1));
    expect(province.disabled).toBe(true);
    expect(days.disabled).toBe(true);
    for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLButtonElement).disabled).toBe(true);
    held.release();
    const after = async () => (await screen.findByLabelText("Province on December 31")) as HTMLSelectElement;
    await waitFor(async () => expect((await after()).disabled).toBe(false));
    expect((await after()).value).toBe("BC");
    expect((screen.getByLabelText("Days you lived in Canada in 2025") as HTMLInputElement).value).toBe("183");
  });

  it("keeps what was typed, the lock and the save's answer when an upload on another step changes the year meanwhile", async () => {
    let read!: () => void;
    const reading = new Promise<void>((resolve) => (read = resolve));
    const late: SlipReader = {
      read: async () => {
        await reading;
        return { kind: "read", taxYear: 2025, model: "test-model", slips: [{ type: "T5", person: "Alex Martin", issuer: "Lakeview Credit Union", boxes: { 13: "1250" }, unsure: [] }] };
      },
    };
    const { router } = await renderApp("/returns/2025/upload", {
      server: { reader: () => late },
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await s.call("PUT", "/api/years/2025/personal-info", {
          as: OWNER,
          body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: false }] },
        });
      },
    });
    fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 late"], "T5.pdf", { type: "application/pdf" })] } });
    await act(() => router.navigate(router.state.location.pathname.replace(/upload$/, "personal")));
    const province = async () => (await screen.findByLabelText("Province on December 31")) as HTMLSelectElement;
    const days = async () => (await screen.findByLabelText("Days you lived in Canada in 2025")) as HTMLInputElement;
    fireEvent.change(await province(), { target: { value: "BC" } });
    fireEvent.change(await days(), { target: { value: "183" } });
    const held = holdRequests((method, path) => method === "PUT" && path === "/api/years/2025/personal-info");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.held()).toBe(1));

    // The upload finishes: the year changes, and the facts start again from it, still locked, with what was typed.
    read();
    expect(await screen.findByRole("link", { name: /Upload documents\s*\(done\)/ })).toBeTruthy();
    await waitFor(async () => expect((await days()).value).toBe("183"));
    expect((await province()).value).toBe("BC");
    expect((await province()).disabled).toBe(true);

    // The save was sent before the upload changed the year: it is refused, and the page says so.
    held.release();
    expect(await screen.findByText("Someone else changed this year")).toBeTruthy();
    expect((await province()).disabled).toBe(false);
    expect((await province()).value).toBe("BC");
    expect((await days()).value).toBe("183");
  });

  describe("after someone else changed the year", () => {
    /** Alex, single, in Ontario, who moved during the year; Personal info open with BC and 183 days typed, not saved. */
    async function typedOnPersonalInfo() {
      let alexId = "";
      const rendered = await renderApp("/returns/2025/personal", {
        seed: async (s) => {
          const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
          alexId = alex.id;
          await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
          await s.call("PUT", "/api/years/2025/personal-info", {
            as: OWNER,
            body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: false }] },
          });
        },
      });
      fireEvent.change(await screen.findByLabelText("Province on December 31"), { target: { value: "BC" } });
      fireEvent.change(await screen.findByLabelText("Days you lived in Canada in 2025"), { target: { value: "183" } });
      return { ...rendered, alexId };
    }
    const province = async () => (await screen.findByLabelText("Province on December 31")) as HTMLSelectElement;
    const days = async () => (await screen.findByLabelText("Days you lived in Canada in 2025")) as HTMLInputElement;
    const revisionOf = async (server: TestServer) => ((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).revision;
    const save = () => clickWhenEnabled(() => screen.getByRole("button", { name: "Save" }));
    /** Waits for the newer year a reload brings: the facts start again from it (a new form), and the old one is gone. */
    async function newerYear(before: HTMLElement) {
      await waitFor(() => expect(screen.getByLabelText("Province on December 31")).not.toBe(before));
    }
    /** Saves, is refused as someone else changed the year, and reloads it from the banner until the newer year is here. */
    async function saveRefusedThenReload() {
      await save();
      const banner = (await screen.findByText("Someone else changed this year")).closest<HTMLElement>("[role=alert]")!;
      const before = await province();
      fireEvent.click(within(banner).getByRole("button", { name: "Reload" }));
      await newerYear(before);
      expect(screen.queryByText("Someone else changed this year")).toBeNull();
    }

    it("keeps what was typed when the year is loaded again, and saves it", async () => {
      const { server, alexId } = await typedOnPersonalInfo();
      // Another tab adds a slip: the year moves on, the facts typed here don't.
      const slip = { revision: await revisionOf(server), personId: alexId, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000" } };
      expect((await server.call("POST", "/api/years/2025/slips", { as: OWNER, body: slip })).status).toBe(201);
      await saveRefusedThenReload();
      expect((await province()).value).toBe("BC");
      expect((await days()).value).toBe("183");
      await save();
      await waitFor(async () => expect(((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).adults[0]).toMatchObject({ province: "BC" }));
      expect(Object.values((await estimate(server)).input.answers)[0]).toMatchObject({ daysResident: "183" });
    });

    it("shows a fact someone else changed meanwhile, and keeps what was typed for the others", async () => {
      const { server, alexId } = await typedOnPersonalInfo();
      const facts = { revision: await revisionOf(server), maritalStatus: "single", adults: [{ personId: alexId, province: "NU", residentAllYear: false }] };
      expect((await server.call("PUT", "/api/years/2025/personal-info", { as: OWNER, body: facts })).status).toBe(200);
      await saveRefusedThenReload();
      await waitFor(async () => expect((await province()).value).toBe("NU"));
      expect((await days()).value).toBe("183");
    });

    it("drops what was typed over a fact someone else changed, so it can't come back and be saved over theirs", async () => {
      const { server, alexId } = await typedOnPersonalInfo();
      const saveElsewhere = async (province: string) => {
        const facts = { revision: await revisionOf(server), maritalStatus: "single", adults: [{ personId: alexId, province, residentAllYear: false }] };
        expect((await server.call("PUT", "/api/years/2025/personal-info", { as: OWNER, body: facts })).status).toBe(200);
      };
      await saveElsewhere("NU");
      await saveRefusedThenReload();
      await waitFor(async () => expect((await province()).value).toBe("NU"));
      // The other tab puts back the province BC was typed over: theirs shows, not BC.
      await saveElsewhere("ON");
      await saveRefusedThenReload();
      await waitFor(async () => expect((await province()).value).toBe("ON"));
      const before = await revisionOf(server);
      await save();
      await waitFor(async () => expect(await revisionOf(server)).toBeGreaterThan(before));
      expect(((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).adults[0]).toMatchObject({ province: "ON" });
    });

    it("waits for the answers to load before saving, so none typed is lost", async () => {
      const { server, alexId } = await typedOnPersonalInfo();
      const slip = { revision: await revisionOf(server), personId: alexId, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000" } };
      expect((await server.call("POST", "/api/years/2025/slips", { as: OWNER, body: slip })).status).toBe(201);
      await save();
      const refused = (await screen.findByText("Someone else changed this year")).closest<HTMLElement>("[role=alert]")!;
      const held = holdRequests((method, path) => method === "GET" && path === "/api/years/2025/estimate");
      fireEvent.click(within(refused).getByRole("button", { name: "Reload" }));
      // The newer year is here; its answers (the estimate) aren't yet.
      await waitFor(() => expect(held.held()).toBe(1));
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("Loading your answers…")).toBeTruthy();
      held.release();
      expect((await days()).value).toBe("183");
      await save();
      await waitFor(async () => expect(Object.values((await estimate(server)).input.answers)[0]).toMatchObject({ daysResident: "183" }));
    });

    it("keeps the page and what was typed when the year can't be loaded again, with a way to try again", async () => {
      const { server, alexId } = await typedOnPersonalInfo();
      const slip = { revision: await revisionOf(server), personId: alexId, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000" } };
      expect((await server.call("POST", "/api/years/2025/slips", { as: OWNER, body: slip })).status).toBe(201);
      await save();
      const refused = (await screen.findByText("Someone else changed this year")).closest<HTMLElement>("[role=alert]")!;
      failRequestOnce((method, path) => method === "GET" && path === "/api/years/2025");
      fireEvent.click(within(refused).getByRole("button", { name: "Reload" }));
      const banner = (await screen.findByText("The year couldn't be loaded again")).closest<HTMLElement>("[role=alert]")!;
      expect((await province()).value).toBe("BC");
      expect((await days()).value).toBe("183");
      const before = await province();
      fireEvent.click(within(banner).getByRole("button", { name: "Try again" }));
      await newerYear(before);
      expect(screen.queryByText("The year couldn't be loaded again")).toBeNull();
      expect((await province()).value).toBe("BC");
      await save();
      await waitFor(async () => expect(((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).adults[0]).toMatchObject({ province: "BC" }));
    });
  });

  it("asks where you lived under its own heading and your spouse's income under theirs, and says what a move to or from Canada does", async () => {
    await renderApp("/returns/2025/personal", {
      seed: async (s) => {
        const alex = (await (await s.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await s.call("POST", "/api/people", { as: OWNER, body: { name: "Sam Martin", relationship: "spouse", birthDate: "1987-09-15" } });
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await s.call("PUT", "/api/years/2025/personal-info", {
          as: OWNER,
          body: { revision: 1, maritalStatus: "married", adults: [{ personId: alex.id, province: "ON", residentAllYear: false }] },
        });
      },
    });
    const headingOver = (element: HTMLElement) => within(element.closest<HTMLElement>('[data-slot="card"]')!).getByRole("heading").textContent;
    expect(headingOver(await screen.findByLabelText("Days you lived in Canada in 2025"))).toBe("Where you lived");
    expect(headingOver(screen.getByLabelText("The part of it from Canada"))).toBe("Where you lived");
    expect(headingOver(screen.getByLabelText("Your spouse's or partner's 2025 net income"))).toBe("Your spouse or partner");
    // Alex moved: the spouse's income for the year (page 1 of the T1), and on Alex's days (the spouse amount).
    expect(headingOver(screen.getByLabelText("Your spouse's or partner's net world income for the days you lived in Canada in 2025"))).toBe(
      "Your spouse or partner",
    );

    const notes = screen.getByRole("heading", { name: "How these answers affect the tax" }).closest<HTMLElement>('[data-slot="card"]')!.textContent;
    expect(notes).not.toMatch(/doesn't handle it yet/);
    expect(notes).toMatch(/reduces the personal amounts .* by the days in Canada/);
    expect(notes).toMatch(/A Quebec return for the year of a move isn't handled yet\./);
    // Every province and territory is handled: no empty group of those that aren't.
    for (const group of document.querySelectorAll("optgroup")) expect(group.querySelectorAll("option").length).toBeGreaterThan(0);
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
    expect(within(add).queryByRole("button", { name: /Add RRSP contributions/ })).toBeNull();
    const row = within(onReturn).getByRole("button", { name: /T4 from Maple Corp/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect((within(onReturn).getByLabelText(/^Box 14/) as HTMLInputElement).value).toBe("60000");
    expect((within(onReturn).getByLabelText(/^Box 24/) as HTMLInputElement).value).toBe("");
    // Typed in, not read from a file: nothing to download.
    expect(within(onReturn).queryByRole("button", { name: "Download the original file" })).toBeNull();
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

  /** Alex in Quebec: $62,000 of pay and $1,800 of transit passes on the T4 (box 14), the pay alone on the RL-1 (box A). */
  const transitPass = async (s: TestServer) => {
    const alex = await seed(s, { province: "QC" });
    for (const [type, boxes] of [
      ["T4", { 14: "63800", 17: "3744", 22: "9000" }],
      ["RL1", { A: "62000", B_A: "3744", E: "6900" }],
    ] as const) {
      const year = (await (await s.call("GET", "/api/years/2025", { as: OWNER })).json()) as TaxYear;
      await s.call("POST", "/api/years/2025/slips", { as: OWNER, body: { revision: year.revision, personId: alex.id, type, issuer: "Maple Corp", boxes } });
    }
  };
  const exemptBenefits = "Benefits on your T4 slips that Quebec doesn't tax";

  it("asks a Quebec resident for the benefits Quebec doesn't tax when the T4 shows more than the RL-1", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: transitPass });
    const ask = exemptBenefits;
    fireEvent.click(within(await screen.findByRole("region", { name: "Add to your return" })).getByRole("button", { name: `Add ${ask}` }));
    expect(screen.getByText(/enter the difference, to the cent; otherwise enter 0\. The main one is a public transit pass/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(ask), { target: { value: "1,800" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(Object.values((await estimate(server)).input.answers)[0]).toMatchObject({ qcExemptBenefits: "1800" }));
    const [result] = (await estimate(server)).result.people;
    expect(result!.missing.map((each) => each.question)).not.toContain("qcExemptBenefits");
    expect(result!.unhandled.join(" ")).not.toMatch(/don't cover the employment income/);
  });

  it("sends a Quebec resident who skipped those benefits back to Income from Finish, and takes the difference there", async () => {
    const { router } = await renderApp("/returns/2025/income", { seed: transitPass });
    const sendsBack = /First check “Benefits on your T4 slips that Quebec doesn't tax” on the Income step/;
    // Saved without adding the amount: it is recorded as none, so the T4 shows $1,800 the RL-1 doesn't.
    fireEvent.click(await screen.findByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/deductions$/));
    await act(() => router.navigate(router.state.location.pathname.replace(/deductions$/, "finish")));
    expect(within(await screen.findByRole("region", { name: "Before you file" })).getByText(sendsBack)).toBeTruthy();
    await act(() => router.navigate(router.state.location.pathname.replace(/finish$/, "income")));
    const add = within(await screen.findByRole("region", { name: "Add to your return" })).queryByRole("button", { name: `Add ${exemptBenefits}` });
    if (add) fireEvent.click(add);
    fireEvent.change(screen.getByLabelText(exemptBenefits), { target: { value: "1800" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect((screen.getByLabelText(exemptBenefits) as HTMLInputElement).value).toBe("1800"));
    await act(() => router.navigate(router.state.location.pathname.replace(/income$/, "finish")));
    await screen.findByRole("list", { name: "Key lines" });
    await waitFor(() => expect(screen.queryByText(sendsBack)).toBeNull());
    // Still listed: the slips to confirm, which the amount didn't change.
    expect(within(screen.getByRole("region", { name: "Before you file" })).getByText(/not confirmed yet/)).toBeTruthy();
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
    // A part asked only for some options of a choice waits for that choice: a class's balances, once a class is chosen.
    expect(screen.queryByLabelText("Undepreciated capital cost at the start of 2025")).toBeNull();
    fireEvent.change(screen.getByLabelText("Capital cost allowance"), { target: { value: "class8" } });
    fireEvent.change(screen.getByLabelText("Undepreciated capital cost at the start of 2025"), { target: { value: "4,000" } });
    const deductions = stepOf(router, "deductions");
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(deductions));
    const answers = Object.values((await estimate(server)).input.answers)[0]!;
    expect(answers).toMatchObject({
      hasSelfEmployment: true,
      selfEmploymentKind: "professional",
      selfEmploymentGross: "90000",
      selfEmploymentExpenses: "20000",
      businessCcaClass: "class8",
      businessUccStart: "4000",
      businessCcaAdditions: "0",
      hasEmploymentIncome: false,
      hasRentalIncome: false,
      soldProperty: false,
    });
    expect(answers).not.toHaveProperty("rentalGross");
    expect(answers).not.toHaveProperty("propertyYearsOwned");
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

  it("retries a refused slip without calling its own earlier save someone else's change", async () => {
    const { server } = await renderApp("/returns/2025/income", { seed: (s) => seed(s).then(() => undefined) });
    const add = await screen.findByRole("region", { name: "Add to your return" });
    fireEvent.click(within(add).getByRole("button", { name: "Add Employment income" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter the T4" }));
    const form = screen.getByRole("form", { name: "Add a slip" });
    fireEvent.change(within(form).getByLabelText("Issued by"), { target: { value: "Maple Corp" } });
    // Three decimals: the module's answers save (a new revision), then the slip is refused.
    fireEvent.change(within(form).getByLabelText(/^Box 14/), { target: { value: "12.345" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(screen.getByRole("form", { name: "Add a slip" })).getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
    const retry = screen.getByRole("form", { name: "Add a slip" });
    fireEvent.change(within(retry).getByLabelText(/^Box 14/), { target: { value: "60000" } });
    fireEvent.click(within(retry).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "On your return" })).getByRole("button", { name: /T4 from Maple Corp/ })).toBeTruthy());
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
    const slips = (await (await server.call("GET", "/api/years/2025/slips")).json()) as { slips: { boxes: Record<string, string> }[] };
    expect(slips.slips).toEqual([expect.objectContaining({ boxes: { 14: "60000" } })]);
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
    expect(within(onReturn).getByRole("button", { name: "Download the original file" })).toBeTruthy();
  });
});

describe("Confirm", () => {
  it("says why a slip wasn't added when no field shows it", async () => {
    await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add a slip" }));
    const form = screen.getByRole("form", { name: "Add a slip" });
    fireEvent.change(within(form).getByLabelText("Issued by"), { target: { value: "Maple Corp" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    const banner = (await within(form).findByText("The slip wasn't saved")).closest<HTMLElement>("[role=alert]")!;
    expect(within(banner).getByText("Enter at least one box")).toBeTruthy();
  });

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

  it("locks a slip's form while it is saved, so nothing typed meanwhile is lost", async () => {
    const { server } = await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit T4 from Maple Corp" }));
    const form = screen.getByRole("form", { name: "Edit T4 from Maple Corp" });
    const box22 = within(form).getByLabelText(/Box 22/) as HTMLInputElement;
    fireEvent.change(box22, { target: { value: "9500" } });
    const held = holdRequests((method, path) => method === "PATCH" && path.startsWith("/api/years/2025/slips/"));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.held()).toBe(1));
    expect(box22.disabled).toBe(true);
    expect((within(form).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    held.release();
    expect(await screen.findByText(/Box 22 Income tax deducted: \$9,500\.00/)).toBeTruthy();
    expect((await estimate(server)).input.slips).toEqual([expect.objectContaining({ boxes: expect.objectContaining({ 22: "9500" }) })]);
  });

  it("stops showing why a box was refused once it is changed, and keeps the other boxes' reasons", async () => {
    await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit T4 from Maple Corp" }));
    const form = screen.getByRole("form", { name: "Edit T4 from Maple Corp" });
    const box = (number: number) => within(form).getByLabelText(new RegExp(`^Box ${number} `)) as HTMLInputElement;
    fireEvent.change(box(14), { target: { value: "2.345" } });
    fireEvent.change(box(22), { target: { value: "1.234" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(box(22).getAttribute("aria-invalid")).toBe("true"));
    expect(box(14).getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(box(22), { target: { value: "9500" } });
    expect(box(22).getAttribute("aria-invalid")).toBeNull();
    expect(within(box(22).closest("tr")!).queryByText("Enter an amount like 1234.56")).toBeNull();
    expect(box(14).getAttribute("aria-invalid")).toBe("true");
    expect(within(box(14).closest("tr")!).getByText("Enter an amount like 1234.56")).toBeTruthy();
  });

  it("waits for a slip being changed before confirming", async () => {
    await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit T4 from Maple Corp" }));
    const form = screen.getByRole("form", { name: "Edit T4 from Maple Corp" });
    fireEvent.change(within(form).getByLabelText(/Box 22/), { target: { value: "9500" } });
    const confirm = () => screen.getByRole("button", { name: "Confirm 1 slip" }) as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    expect(screen.getByText("Save or cancel the slip you're changing before confirming.")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(confirm().disabled).toBe(false);
  });

  it("locks the slips while they are confirmed", async () => {
    await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    const held = holdRequests((method, path) => method === "POST" && path === "/api/years/2025/slips/confirm");
    fireEvent.click(await screen.findByRole("button", { name: "Confirm 1 slip" }));
    await waitFor(() => expect(held.held()).toBe(1));
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button("Edit T4 from Maple Corp").disabled).toBe(true);
    expect(button("Remove T4 from Maple Corp").disabled).toBe(true);
    expect(button("Add a slip").disabled).toBe(true);
    held.release();
    expect(await screen.findByText("Confirmed")).toBeTruthy();
    expect(button("Edit T4 from Maple Corp").disabled).toBe(false);
  });

  describe("while the year changes in the background", () => {
    /** Alex's T4 at Confirm, with an upload started on Upload documents whose reading waits for `read()`. */
    async function confirmWhileUploading() {
      let read!: () => void;
      const reading = new Promise<void>((resolve) => (read = resolve));
      const late: SlipReader = {
        read: async () => {
          await reading;
          return { kind: "read", taxYear: 2025, model: "test-model", slips: [{ type: "T5", person: "Alex Martin", issuer: "Lakeview Credit Union", boxes: { 13: "1250" }, unsure: [] }] };
        },
      };
      const rendered = await renderApp("/returns/2025/upload", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined), server: { reader: () => late } });
      fireEvent.change(await screen.findByLabelText("Choose files"), { target: { files: [new File(["%PDF-1.4 late"], "T5.pdf", { type: "application/pdf" })] } });
      await act(() => rendered.router.navigate(rendered.router.state.location.pathname.replace(/upload$/, "confirm")));
      return { ...rendered, read };
    }
    const editor = () => screen.getByRole("form", { name: "Edit T4 from Maple Corp" });
    const box = (number: number) => within(editor()).getByLabelText(new RegExp(`^Box ${number} `)) as HTMLInputElement;
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    const reloadingSlips = (method: string, path: string) => method === "GET" && path === "/api/years/2025/slips";
    /** The T4 as stored, and the year's revision, as another tab would read them. */
    async function storedT4(server: TestServer) {
      const { slips } = (await (await server.call("GET", "/api/years/2025/slips")).json()) as SlipList;
      const { revision } = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
      return { t4: slips.find((slip) => slip.type === "T4")!, revision };
    }
    async function openT4(box22: string) {
      fireEvent.click(await screen.findByRole("button", { name: "Edit T4 from Maple Corp" }));
      fireEvent.change(box(22), { target: { value: box22 } });
    }

    it("keeps a slip being changed open with what was typed, and saves it once the slips are loaded again", async () => {
      const { server, read } = await confirmWhileUploading();
      await openT4("9500");
      const held = holdRequests(reloadingSlips);
      read();
      await waitFor(() => expect(held.held()).toBe(1));
      // While the slips load again, typing goes on; saving and confirming wait.
      fireEvent.change(box(22), { target: { value: "9600" } });
      expect(within(editor()).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
      held.release();
      expect(await screen.findByText("T5 · Lakeview Credit Union")).toBeTruthy();
      expect(box(22).value).toBe("9600");
      fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
      expect(await screen.findByText(/Box 22 Income tax deducted: \$9,600\.00/)).toBeTruthy();
      expect((await storedT4(server)).t4.boxes).toMatchObject({ 14: "60000", 22: "9600" });
    });

    it("waits for the slips to load again before confirming, adding or removing", async () => {
      const { read } = await confirmWhileUploading();
      await screen.findByRole("button", { name: "Confirm 1 slip" });
      const held = holdRequests(reloadingSlips);
      read();
      await waitFor(() => expect(held.held()).toBe(1));
      expect(button("Confirm 1 slip").disabled).toBe(true);
      expect(button("Add a slip").disabled).toBe(true);
      expect(button("Remove T4 from Maple Corp").disabled).toBe(true);
      held.release();
      expect(await screen.findByText("T5 · Lakeview Credit Union")).toBeTruthy();
      expect(button("Confirm 2 slips").disabled).toBe(false);
      expect(button("Add a slip").disabled).toBe(false);
    });

    it("shows another tab's change to the slip being changed, and never saves over it", async () => {
      const { server, read } = await confirmWhileUploading();
      await openT4("9500");
      const { t4, revision } = await storedT4(server);
      const elsewhere = await server.call("PATCH", `/api/years/2025/slips/${t4.id}`, { as: OWNER, body: { revision, boxes: { ...t4.boxes, 14: "70000" } } });
      expect(elsewhere.status).toBe(200);
      read();
      expect(await screen.findByText("T5 · Lakeview Credit Union")).toBeTruthy();
      expect(await screen.findByText(/Someone else changed this slip while you were changing it/)).toBeTruthy();
      expect(box(14).value).toBe("70000");
      fireEvent.change(box(22), { target: { value: "9500" } });
      fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
      expect(await screen.findByText(/Box 22 Income tax deducted: \$9,500\.00/)).toBeTruthy();
      expect((await storedT4(server)).t4.boxes).toMatchObject({ 14: "70000", 22: "9500" });
    });

    it("closes a slip being changed that was removed meanwhile, and says so", async () => {
      const { server, read } = await confirmWhileUploading();
      await openT4("9500");
      const { t4, revision } = await storedT4(server);
      expect((await server.call("DELETE", `/api/years/2025/slips/${t4.id}`, { as: OWNER, body: { revision } })).status).toBe(200);
      read();
      expect(await screen.findByText("The slip you were changing was removed or replaced.")).toBeTruthy();
      expect(screen.queryByRole("form", { name: "Edit T4 from Maple Corp" })).toBeNull();
      expect(button("Confirm 1 slip").disabled).toBe(false);
    });

    it("keeps a slip being changed, with the error and a way to try again, when the slips can't be loaded again", async () => {
      const { server, read } = await confirmWhileUploading();
      await openT4("9500");
      const failing = failRequestOnce(reloadingSlips);
      read();
      const banner = (await screen.findByText("The slips couldn't be loaded again")).closest<HTMLElement>("[role=alert]")!;
      expect(failing.failed()).toBe(true);
      expect(box(22).value).toBe("9500");
      fireEvent.click(within(banner).getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("T5 · Lakeview Credit Union")).toBeTruthy();
      expect(box(22).value).toBe("9500");
      fireEvent.click(within(editor()).getByRole("button", { name: "Save" }));
      expect(await screen.findByText(/Box 22 Income tax deducted: \$9,500\.00/)).toBeTruthy();
      expect((await storedT4(server)).t4.boxes).toMatchObject({ 22: "9500" });
    });
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

  it("shows a box AI couldn't read, and waits for it, or 0 when it is blank, before confirming", async () => {
    const reader: SlipReader = {
      read: async () => ({ kind: "read", taxYear: 2025, model: "test-model", slips: [{ type: "T4", person: "ALEX MARTIN", issuer: "Maple Corp", boxes: { 22: "9000" }, unsure: ["14"] }] }),
    };
    const pdf = new TextEncoder().encode("%PDF-1.4\n% a sample T4\n%%EOF\n") as Uint8Array<ArrayBuffer>;
    const { server } = await renderApp("/returns/2025/confirm", {
      server: { reader: () => reader },
      seed: async (s) => {
        await seed(s, { applies: true });
        await s.call("POST", "/api/years/2025/documents", { as: OWNER, raw: pdf, headers: { "Content-Type": "application/pdf", "X-File-Name": "T4.pdf" } });
      },
    });
    const item = (await screen.findByText("T4 · Maple Corp")).closest("li")!;
    expect(item.textContent).toContain("Box 14 Employment income: couldn't be read (check) · Box 22 Income tax deducted: $9,000.00");
    expect((screen.getByRole("button", { name: "Confirm 1 slip" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Before confirming, enter each box that couldn't be read, or 0 if it is blank on the slip: choose Edit on its slip.")).toBeTruthy();

    // Blank on the paper slip: 0 is an amount to save.
    fireEvent.click(within(item).getByRole("button", { name: "Edit T4 from Maple Corp" }));
    const form = screen.getByRole("form", { name: "Edit T4 from Maple Corp" });
    const save = within(form).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Box 14 Employment income"), { target: { value: "0" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm 1 slip" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("T4 · Maple Corp").closest("li")!.textContent).toContain("Box 14 Employment income: $0.00 · Box 22");
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 slip" }));
    expect(await screen.findByText("Confirmed")).toBeTruthy();
    expect((await estimate(server)).input.slips).toEqual([expect.objectContaining({ type: "T4", boxes: { 14: "0", 22: "9000" } })]);
  });

  it("lists the boxes in the order printed", async () => {
    await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add a slip" }));
    const rows = within(screen.getByRole("form", { name: "Add a slip" })).getAllByRole("row").slice(1) as HTMLTableRowElement[];
    expect(rows.slice(0, 6).map((row) => row.cells[0]!.textContent)).toEqual(["14", "16", "16A", "17", "17A", "18"]);
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

  it("says a count is above its question's max as it is typed", async () => {
    await renderApp("/returns/2025/deductions", { seed: (s) => seed(s, { applies: true, province: "NU" }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add Lived in the North" }));
    const days = screen.getByLabelText("Days you lived there in 2025");
    fireEvent.change(days, { target: { value: "366" } });
    expect(days.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter a whole number from 0 to 365")).toBeTruthy();
    fireEvent.change(days, { target: { value: "365" } });
    expect(screen.queryByText("Enter a whole number from 0 to 365")).toBeNull();
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
    // Three or more questions of one step left: one item for the step, naming the first two.
    expect(screen.getByText(/^\d+ questions on Deductions not answered yet: /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Net federal tax/ }));
    expect(screen.getByText("= line.T1.41700 + line.T1.41500")).toBeTruthy();
  });
});
