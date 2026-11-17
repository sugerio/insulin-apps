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

  it("asks who is in the year, and starts it with them", async () => {
    const { router, server } = await renderApp("/returns", { seed: async (s) => void (await seedPeople(s)) });
    fireEvent.click(await screen.findByRole("button", { name: "Start 2025" }));
    expect((checkbox("Alex Martin") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(checkbox("Jamie Martin"));
    expect(screen.getByRole("link", { name: "Add a new person" }).getAttribute("href")).toBe(`/household?back=${encodeURIComponent("/returns?start=2025")}`);
    fireEvent.click(screen.getByRole("button", { name: "Start 2025" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/returns/2025/household"));
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    expect(year.prepareTogether).toBe(true);
    expect(year.members.map((id) => year.people.find((person) => person.id === id)?.name)).toEqual(["Alex Martin", "Sam Martin"]);
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
});

describe("step 1 of a year", () => {
  it("saves the year's facts and moves on", async () => {
    const { router, server } = await renderApp("/returns/2025/household", {
      seed: async (s) => {
        const alex = await add(s, "Alex Martin", "self", "1985-04-02");
        await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
      },
    });
    fireEvent.click(await screen.findByRole("radio", { name: "Single" }));
    fireEvent.change(screen.getByLabelText("Province on December 31"), { target: { value: "BC" } });
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/returns/2025/upload"));
    expect(await screen.findByText("Not available yet")).toBeTruthy();
    const stored = await (await server.call("GET", "/api/years/2025")).json();
    expect(stored).toMatchObject({ maritalStatus: "single", steps: { household: "done" } });
  });

  it("asks for both adults' facts while the spouse is in the year, and only yours once taken out", async () => {
    await renderApp("/returns/2025/household", { seed: seedCouple });
    expect(await screen.findByText("Both returns are prepared together.")).toBeTruthy();
    expect(screen.getAllByLabelText("Province on December 31")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(checkbox("Sam Martin"));
    fireEvent.click(screen.getByRole("button", { name: "Save people" }));
    expect(await screen.findByText("Only your return is prepared.")).toBeTruthy();
    expect(screen.getAllByLabelText("Province on December 31")).toHaveLength(1);
  });

  it("lists what is still missing, as last saved", async () => {
    await renderApp("/returns/2025/household", { seed: seedCouple });
    expect(await screen.findByText("Before you continue")).toBeTruthy();
    expect(screen.getByText("Choose your marital status on December 31.")).toBeTruthy();
  });

  it("shows a viewer the year without anything to change", async () => {
    await renderApp("/returns/2025/household", { as: VIEWER, seed: seedCouple });
    expect(await screen.findByText("Both returns are prepared together.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLButtonElement).disabled).toBe(true);
  });
});
