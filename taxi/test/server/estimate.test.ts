import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Estimate, Person } from "#shared";
import { VIEWER, startServer, type TestServer } from "../support/server.ts";

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

const addPerson = async (name: string, relationship: string, birthDate: string) =>
  (await (await server.call("POST", "/api/people", { body: { name, relationship, birthDate } })).json()) as Person;

describe("a year's estimate", () => {
  it("runs the engine on each return of the year, with the input to explain it", async () => {
    const alex = await addPerson("Alex Martin", "self", "1985-04-02");
    const sam = await addPerson("Sam Martin", "spouse", "1987-09-15");
    await server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id, sam.id] } });
    await server.call("PUT", "/api/years/2025/personal-info", {
      body: { revision: 1, maritalStatus: "married", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }, { personId: sam.id, province: "BC", residentAllYear: true }] },
    });

    const response = await server.call("GET", "/api/years/2025/estimate", { as: VIEWER });
    expect(response.status).toBe(200);
    const estimate = (await response.json()) as Estimate;
    expect(estimate.input).toEqual({
      year: 2025,
      people: [
        { id: alex.id, name: "Alex Martin", role: "self", birthDate: "1985-04-02", province: "ON", residentAllYear: true },
        { id: sam.id, name: "Sam Martin", role: "spouse", birthDate: "1987-09-15", province: "BC", residentAllYear: true },
      ],
      family: { maritalStatus: "married", dependants: [] },
      answers: {},
      slips: [],
    });
    expect(estimate.result.people.map((person) => person.personId)).toEqual([alex.id, sam.id]);
    expect(estimate.result.people[0]!.lines.find((line) => line.id === "T1.42000")).toEqual({ id: "T1.42000", label: "Net federal tax", value: "0", status: "estimate" });
    expect(estimate.result.people[0]!.estimates).toContainEqual({ question: "rrspDeduction", ask: "RRSP contributions to deduct for 2025", assumed: "0" });
    // Sam lives in British Columbia: BC428 applies to Sam's return.
    expect(estimate.result.people[1]!.lines.find((line) => line.id === "T1.42800")).toMatchObject({ value: "0", status: "estimate" });
    expect(estimate.result.people[1]!.unhandled).toEqual([]);
  });

  it("covers only your return when your spouse isn't in the year", async () => {
    const alex = await addPerson("Alex Martin", "self", "1985-04-02");
    await addPerson("Sam Martin", "spouse", "1987-09-15");
    await server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id] } });
    const estimate = (await (await server.call("GET", "/api/years/2025/estimate")).json()) as Estimate;
    expect(estimate.input.people.map((person) => person.name)).toEqual(["Alex Martin"]);
  });

  it("is not found for a year that hasn't started", async () => {
    expect((await server.call("GET", "/api/years/2025/estimate")).status).toBe(404);
  });
});
