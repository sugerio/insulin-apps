import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
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

  it("says the returns can't be worked out when the rules can't read what is stored, and marks no step done", async () => {
    const alex = await addPerson("Alex Martin", "self", "1985-04-02");
    await server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id] } });
    await server.call("PUT", "/api/years/2025/personal-info", {
      body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] },
    });
    const answers = Object.fromEntries(
      [...rulesFor(2025)!.questions.values()]
        .filter((question) => question.module === "income" && question.type === "boolean")
        .map((question) => [question.id, false]),
    );
    await server.call("PUT", "/api/years/2025/answers", { body: { revision: 2, personId: alex.id, answers } });
    expect(((await (await server.call("GET", "/api/years/2025")).json()) as TaxYear).returns[0]!.steps.income).toBe("done");
    // A stored answer the rules no longer accept (an option renamed in a later release): the engine refuses the input.
    const { id: taxYearId } = (await server.db.prepare("SELECT id FROM tax_years").first<{ id: string }>())!;
    await server.db
      .prepare("INSERT INTO answers (id, org_id, tax_year_id, person_id, question, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0)")
      .bind("stale", "org-a", taxYearId, alex.id, "selfEmploymentKind", JSON.stringify("an option that no longer exists"))
      .run();

    const estimate = await server.call("GET", "/api/years/2025/estimate");
    expect(estimate.status).toBe(500);
    expect(((await estimate.json()) as { error: { message: string } }).error.message).toMatch(/can't be worked out/);
    const year = (await (await server.call("GET", "/api/years/2025")).json()) as TaxYear;
    expect(year.returns[0]!.steps).toMatchObject({ personal: "todo", income: "todo", deductions: "todo", credits: "todo", finish: "todo" });
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
