import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Person, TaxYear } from "#shared";
import { OWNER, VIEWER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

async function add(server: TestServer, name: string, relationship: string, birthDate: string): Promise<Person> {
  return (await (await server.call("POST", "/api/people", { as: OWNER, body: { name, relationship, birthDate } })).json()) as Person;
}

async function seedPeople(server: TestServer) {
  return {
    alex: await add(server, "Alex Martin", "self", "1985-04-02"),
    sam: await add(server, "Sam Martin", "spouse", "1987-09-15"),
    jamie: await add(server, "Jamie Martin", "child", "2019-06-20"),
  };
}

async function seedCouple(server: TestServer) {
  const { alex, sam } = await seedPeople(server);
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id, sam.id] } });
}

const checkbox = (name: string) => screen.getByRole("checkbox", { name });

describe("the Household page", () => {
  it("adds yourself first, then the others", async () => {
    const { server } = await renderApp("/household");
    const form = await screen.findByRole("form", { name: "Add a person" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Alex Martin" } });
    fireEvent.change(within(form).getByLabelText("Birth date"), { target: { value: "1985-04-02" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("button", { name: "Edit Alex Martin" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    const next = await screen.findByRole("form", { name: "Add a person" });
    expect((within(next).getByLabelText("Relationship") as HTMLSelectElement).value).toBe("spouse");
    const { people } = (await (await server.call("GET", "/api/people")).json()) as { people: Person[] };
    expect(people.map((person) => person.relationship)).toEqual(["self"]);
  });

  it("offers the way back to the page that sent you", async () => {
    await renderApp("/household?back=%2Freturns%3Fstart%3D2025", { seed: async (s) => void (await seedPeople(s)) });
    const back = await screen.findByRole("link", { name: "Back to Start 2025" });
    expect(back.getAttribute("href")).toBe("/returns?start=2025");
  });

  it("never sends you back off the returns", async () => {
    await renderApp("/household?back=https%3A%2F%2Felsewhere.example", { seed: async (s) => void (await seedPeople(s)) });
    await screen.findByRole("button", { name: "Edit Alex Martin" });
    expect(screen.queryByRole("link", { name: /^Back/ })).toBeNull();
  });

  it("asks before removing a person, saying what goes with them, and removes nothing until you confirm", async () => {
    const { server } = await renderApp("/household", { seed: seedCouple });
    const names = async () => ((await (await server.call("GET", "/api/people")).json()) as { people: Person[] }).people.map((person) => person.name);
    const question = () => screen.getByText("Remove Sam Martin?").closest<HTMLElement>("[role=status]")!;
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam Martin" }));
    expect(question().textContent).toMatch(/their facts, answers and slips in every tax year they are in are deleted too/);
    expect(await names()).toEqual(["Alex Martin", "Sam Martin", "Jamie Martin"]);
    fireEvent.click(within(question()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Remove Sam Martin?")).toBeNull();
    expect(await names()).toEqual(["Alex Martin", "Sam Martin", "Jamie Martin"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove Sam Martin" }));
    fireEvent.click(within(question()).getByRole("button", { name: "Remove person" }));
    await waitFor(() => expect(screen.queryByText("Sam Martin")).toBeNull());
    expect(await names()).toEqual(["Alex Martin", "Jamie Martin"]);
  });

  it("shows a viewer the people without anything to change", async () => {
    await renderApp("/household", { as: VIEWER, seed: async (s) => void (await seedPeople(s)) });
    expect(await screen.findByText("Sam Martin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });
});

describe("starting a year", () => {
  it("sends you to the Household when you haven't added yourself", async () => {
    await renderApp("/returns");
    const link = await screen.findByRole("link", { name: "Go to Household" });
    expect(link.getAttribute("href")).toBe(`/household?back=${encodeURIComponent("/returns?start=2025")}`);
  });

  it("says what the app covers and what it doesn't yet", async () => {
    await renderApp("/returns");
    const covers = (await screen.findByRole("heading", { name: "What this app covers" })).closest<HTMLElement>("[data-slot=card]")!;
    const [handled, notYet] = within(covers).getAllByText(/./, { selector: "p" }).map((paragraph) => paragraph.textContent ?? "");
    expect(handled).toMatch(/self-employment and rental income, income earned abroad/);
    expect(notYet).toMatch(/^Not yet: .*moving to or from Canada during the year.*capital cost allowance/);
    expect(notYet).not.toMatch(/self-employment|rental|outside Canada/);
  });

  it("asks who is in the year, and starts it with them", async () => {
    const { router, server } = await renderApp("/returns", { seed: async (s) => void (await seedPeople(s)) });
    fireEvent.click(await screen.findByRole("button", { name: "Start 2025" }));
    // Only you to begin with: everyone else is added by choice.
    expect((checkbox("Alex Martin") as HTMLButtonElement).disabled).toBe(true);
    expect(checkbox("Alex Martin").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Sam Martin").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Jamie Martin").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox("Sam Martin"));
    expect(screen.getByRole("link", { name: "Add a new person" }).getAttribute("href")).toBe(`/household?back=${encodeURIComponent("/returns?start=2025")}`);
    fireEvent.click(screen.getByRole("button", { name: "Start 2025" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/returns\/2025\/[0-9a-f-]{36}\/household$/));
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    // The year opens on the return of the person preparing.
    expect(router.state.location.pathname).toBe(`/returns/2025/${year.adults[0]!.personId}/household`);
    expect(year.prepareTogether).toBe(true);
    expect(year.members.map((id) => year.people.find((person) => person.id === id)?.name)).toEqual(["Alex Martin", "Sam Martin"]);
  });

  it("changes who is in a started year on the Tax years page", async () => {
    const { server } = await renderApp("/returns", { seed: seedCouple });
    const people = await screen.findByRole("region", { name: "People in 2025" });
    expect(within(people).getByText("Sam Martin")).toBeTruthy();
    expect(screen.getByRole("list", { name: "2025 returns" }).querySelectorAll(":scope > li")).toHaveLength(2);
    fireEvent.click(within(people).getByRole("button", { name: "Change" }));
    fireEvent.click(checkbox("Sam Martin"));
    expect(within(people).getByText("Taking Sam Martin out of 2025")).toBeTruthy();
    fireEvent.click(checkbox("Jamie Martin"));
    fireEvent.click(within(people).getByRole("button", { name: "Save people" }));
    // Sam out of the year has no return; Jamie is a dependant on Alex's.
    await waitFor(() => expect(screen.getByRole("list", { name: "2025 returns" }).querySelectorAll(":scope > li")).toHaveLength(1));
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    expect(year.members.map((id) => year.people.find((person) => person.id === id)?.name)).toEqual(["Alex Martin", "Jamie Martin"]);
    expect(year.prepareTogether).toBe(false);
  });

  it("opens the choice straight away on the way back from the Household", async () => {
    await renderApp("/returns?start=2025", { seed: async (s) => void (await seedPeople(s)) });
    expect(await screen.findByRole("heading", { name: "Start 2025: who is in this year?" })).toBeTruthy();
  });

  it("doesn't offer a viewer to start a year", async () => {
    await renderApp("/returns", { as: VIEWER, seed: async (s) => void (await seedPeople(s)) });
    expect(await screen.findByText(/Someone who prepares returns starts the year/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start 2025" })).toBeNull();
  });

  it("doesn't offer a viewer to change who is in a year", async () => {
    await renderApp("/returns", { as: VIEWER, seed: seedCouple });
    const people = await screen.findByRole("region", { name: "People in 2025" });
    expect(within(people).getByText("Sam Martin")).toBeTruthy();
    expect(within(people).queryByRole("button", { name: "Change" })).toBeNull();
  });
});

describe("step 1 of a year", () => {
  it("saves the year's facts and moves on", async () => {
    let alex: Person | undefined;
    const { router, server } = await renderApp("/returns/2025/household", {
      seed: async (s) => {
        alex = await add(s, "Alex Martin", "self", "1985-04-02");
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
      },
    });
    fireEvent.click(await screen.findByRole("radio", { name: "Single" }));
    expect(screen.queryByRole("radio", { name: "Married" })).toBeNull();
    const back = `/returns/2025/${alex!.id}/household`;
    expect(screen.getByRole("link", { name: "Add a spouse or partner" }).getAttribute("href")).toBe(`/household?back=${encodeURIComponent(back)}`);
    fireEvent.change(screen.getByLabelText("Province on December 31"), { target: { value: "BC" } });
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/returns/2025/${alex!.id}/upload`));
    expect(await screen.findByRole("heading", { name: "Upload documents" })).toBeTruthy();
    const stored = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    expect(stored.maritalStatus).toBe("single");
    expect(stored.returns[0]!.steps.household).toBe("done");
  });

  it("shows one adult's return, with a switcher to the other's", async () => {
    const { router } = await renderApp("/returns/2025/household", { seed: seedCouple });
    expect(await screen.findAllByLabelText("Province on December 31")).toHaveLength(1);
    expect(screen.getAllByRole("radio", { name: /^(Married|Living common-law|Single|Widowed|Divorced|Separated)$/ }).map((radio) => radio.getAttribute("value"))).toEqual(["married", "common_law"]);
    // Who is in the year is chosen on the Tax years page, not here.
    expect(screen.queryByRole("heading", { name: "Household in 2025" })).toBeNull();
    const alexPath = router.state.location.pathname;

    const switcher = screen.getByRole("button", { name: "Return of Alex Martin: switch return" });
    fireEvent.keyDown(switcher, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Sam Martin/ }));
    await waitFor(() => expect(router.state.location.pathname).not.toBe(alexPath));
    expect(router.state.location.pathname).toMatch(/\/household$/);
    expect(await screen.findByRole("button", { name: "Return of Sam Martin: switch return" })).toBeTruthy();
  });

  it("shows the other adult's own facts after switching at the same step, and saves them as theirs", async () => {
    let people: { alex: Person; sam: Person } | undefined;
    const { router, server } = await renderApp("/returns/2025/household", {
      seed: async (s) => {
        const { alex, sam } = await seedPeople(s);
        people = { alex, sam };
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id, sam.id] } });
        await s.call("PUT", "/api/years/2025/household", {
          as: OWNER,
          body: {
            revision: 1,
            maritalStatus: "married",
            adults: [
              { personId: alex.id, province: "ON", residentAllYear: true },
              { personId: sam.id, province: "BC", residentAllYear: false },
            ],
          },
        });
      },
    });
    const province = async () => ((await screen.findByLabelText("Province on December 31")) as HTMLSelectElement).value;
    expect(await province()).toBe("ON");
    fireEvent.keyDown(screen.getByRole("button", { name: "Return of Alex Martin: switch return" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Sam Martin/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/returns/2025/${people!.sam.id}/household`));
    await screen.findByRole("button", { name: "Return of Sam Martin: switch return" });
    expect(await province()).toBe("BC");
    expect(screen.getByRole("radio", { name: "No" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const stored = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
      expect(stored.revision).toBe(3);
      expect(stored.adults).toEqual([
        expect.objectContaining({ personId: people!.alex.id, province: "ON", residentAllYear: true }),
        expect.objectContaining({ personId: people!.sam.id, province: "BC", residentAllYear: false }),
      ]);
    });
  });

  it("says what is still missing only when you try to continue", async () => {
    const { router } = await renderApp("/returns/2025/household", { seed: seedCouple });
    fireEvent.click(await screen.findByRole("radio", { name: "Married" }));
    expect(screen.queryByText("Fill these in to continue")).toBeNull();
    const path = router.state.location.pathname;
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("Fill these in to continue")).toBeTruthy();
    expect(screen.getByText("Choose Alex Martin's province on December 31.")).toBeTruthy();
    // Sam's facts are Sam's return's.
    expect(screen.queryByText("Choose Sam Martin's province on December 31.")).toBeNull();
    expect(screen.queryByText("Choose your marital status on December 31.")).toBeNull();
    expect(router.state.location.pathname).toBe(path);
  });

  it("shows a viewer the year without anything to change", async () => {
    await renderApp("/returns/2025/household", { as: VIEWER, seed: seedCouple });
    expect(await screen.findByRole("heading", { name: "Marital status on December 31, 2025" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLButtonElement).disabled).toBe(true);
  });
});
