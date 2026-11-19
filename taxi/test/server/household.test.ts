import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Person, TaxYear, YearList } from "#shared";
import { startServer, type TestServer } from "../support/server.ts";

let server: TestServer;
beforeEach(async () => {
  server = await startServer({ now: () => 1_767_225_600_000 });
});
afterEach(() => server.close());

async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answer = await response;
  const body = await answer.json();
  expect(answer.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

const addPerson = (name: string, relationship: string, birthDate = "1985-04-02") =>
  json<Person>(server.call("POST", "/api/people", { body: { name, relationship, birthDate } }), 201);

const startYear = (people: Person[], status = 201) =>
  json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: people.map((person) => person.id) } }), status);

/** Alex and Sam, both in 2025: their returns are prepared together. */
async function marriedCouple() {
  const alex = await addPerson("Alex Martin", "self");
  const sam = await addPerson("Sam Martin", "spouse", "1987-09-15");
  const year = await startYear([alex, sam]);
  return { alex, sam, year };
}

const facts = (revision: number, maritalStatus: string, adults: { personId: string; province: string | null; residentAllYear: boolean | null }[]) => ({
  revision,
  maritalStatus,
  adults,
});

describe("the household's people", () => {
  it("lists everyone, you first", async () => {
    await addPerson("Jamie Martin", "child", "2019-06-20");
    await addPerson("Alex Martin", "self");
    const { people } = await json<{ people: Person[] }>(server.call("GET", "/api/people"));
    expect(people.map((person) => person.name)).toEqual(["Alex Martin", "Jamie Martin"]);
  });

  it("keeps one 'you' and one spouse per household", async () => {
    await marriedCouple();
    expect((await server.call("POST", "/api/people", { body: { name: "Another Me", relationship: "self", birthDate: "1990-01-01" } })).status).toBe(409);
    expect((await server.call("POST", "/api/people", { body: { name: "Another Spouse", relationship: "spouse", birthDate: "1990-01-01" } })).status).toBe(409);
    await addPerson("Jamie Martin", "child", "2019-06-20");
    await addPerson("Robin Martin", "child", "2021-02-11");
  });

  it("refuses invalid fields with the path of each issue", async () => {
    const response = await server.call("POST", "/api/people", { body: { name: " ", relationship: "cousin", birthDate: "2099-01-01" } });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { issues: { path: string }[] } };
    expect(body.error.issues.map((issue) => issue.path).sort()).toEqual(["birthDate", "name", "relationship"]);
  });

  it("never changes who 'you' are, and never removes you", async () => {
    const { alex, sam } = await marriedCouple();
    expect((await server.call("PATCH", `/api/people/${alex.id}`, { body: { relationship: "child" } })).status).toBe(409);
    expect((await server.call("PATCH", `/api/people/${sam.id}`, { body: { relationship: "self" } })).status).toBe(409);
    expect((await server.call("DELETE", `/api/people/${alex.id}`)).status).toBe(409);
    const renamed = await json<Person>(server.call("PATCH", `/api/people/${alex.id}`, { body: { name: "Alex M. Martin" } }));
    expect(renamed).toMatchObject({ name: "Alex M. Martin", relationship: "self", birthDate: "1985-04-02" });
  });

  it("removes a person from the household and from every year", async () => {
    const { alex, sam } = await marriedCouple();
    await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", {
        body: facts(1, "married", [
          { personId: alex.id, province: "ON", residentAllYear: true },
          { personId: sam.id, province: "ON", residentAllYear: true },
        ]),
      }),
    );
    expect((await server.call("DELETE", `/api/people/${sam.id}`)).status).toBe(204);
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    expect(year.members).toEqual([alex.id]);
    expect(year.prepareTogether).toBe(false);
    const returns = await server.db.prepare("SELECT person_id FROM returns").all<{ person_id: string }>();
    expect(returns.results.map((row) => row.person_id)).toEqual([alex.id]);
  });
});

describe("starting a tax year", () => {
  it("starts with the people chosen; your spouse in it prepares both returns together", async () => {
    const alex = await addPerson("Alex Martin", "self");
    const sam = await addPerson("Sam Martin", "spouse", "1987-09-15");
    const jamie = await addPerson("Jamie Martin", "child", "2019-06-20");
    const year = await startYear([alex, sam, jamie]);
    expect(year).toMatchObject({ year: 2025, revision: 1, maritalStatus: null, prepareTogether: true, members: [alex.id, sam.id, jamie.id] });
    expect(year.adults.map((adult) => adult.personId)).toEqual([alex.id, sam.id]);
    expect(year.returns[0]!.steps.household).toBe("todo");
    expect(year.returns[0]!.steps.upload).toBe("todo");
  });

  it("prepares only your return when your spouse isn't chosen", async () => {
    const alex = await addPerson("Alex Martin", "self");
    await addPerson("Sam Martin", "spouse", "1987-09-15");
    const year = await startYear([alex]);
    expect(year.prepareTogether).toBe(false);
    expect(year.adults.map((adult) => adult.personId)).toEqual([alex.id]);
  });

  it("needs you in the household and in the year", async () => {
    expect((await server.call("POST", "/api/years", { body: { year: 2025, people: [crypto.randomUUID()] } })).status).toBe(400);
    const sam = await addPerson("Sam Martin", "spouse");
    expect((await server.call("POST", "/api/years", { body: { year: 2025, people: [sam.id] } })).status).toBe(409);
    const alex = await addPerson("Alex Martin", "self");
    expect((await server.call("POST", "/api/years", { body: { year: 2025, people: [sam.id] } })).status).toBe(400);
    await startYear([alex]);
  });

  it("returns a started year unchanged, whoever is asked for", async () => {
    const { alex } = await marriedCouple();
    const again = await startYear([alex], 200);
    expect(again).toMatchObject({ revision: 1, prepareTogether: true });
  });

  it("refuses a year the app has no rules for", async () => {
    const alex = await addPerson("Alex Martin", "self");
    expect((await server.call("POST", "/api/years", { body: { year: 2019, people: [alex.id] } })).status).toBe(400);
    expect((await server.call("GET", "/api/years/2019")).status).toBe(404);
  });

  it("lists the years with each adult's return", async () => {
    const { alex, sam } = await marriedCouple();
    const list = await json<YearList>(server.call("GET", "/api/years"));
    expect(list.supportedYears).toEqual([2025]);
    expect(list.years[0]!.members).toEqual([alex.id, sam.id]);
    expect(list.years[0]!.returns.map((each) => [each.personId, each.name, each.steps.household])).toEqual([
      [alex.id, "Alex Martin", "todo"],
      [sam.id, "Sam Martin", "todo"],
    ]);
  });
});

describe("changing who is in a year", () => {
  it("takes your spouse out, with their facts for that year", async () => {
    const { alex, sam } = await marriedCouple();
    await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", {
        body: facts(1, "married", [
          { personId: alex.id, province: "ON", residentAllYear: true },
          { personId: sam.id, province: "BC", residentAllYear: true },
        ]),
      }),
    );
    const year = await json<TaxYear>(server.call("PUT", "/api/years/2025/people", { body: { revision: 2, people: [alex.id] } }));
    expect(year).toMatchObject({ revision: 3, prepareTogether: false, members: [alex.id] });
    expect(year.adults).toEqual([{ personId: alex.id, province: "ON", residentAllYear: true, prepared: true }]);
    // Sam is still in the household.
    expect(year.people.map((person) => person.id)).toContain(sam.id);
    const back = await json<TaxYear>(server.call("PUT", "/api/years/2025/people", { body: { revision: 3, people: [alex.id, sam.id] } }));
    expect(back.adults.find((adult) => adult.personId === sam.id)).toMatchObject({ province: null, residentAllYear: null });
  });

  it("refuses a stale revision and changes nothing", async () => {
    const { alex, sam } = await marriedCouple();
    await json<TaxYear>(server.call("PUT", "/api/years/2025/people", { body: { revision: 1, people: [alex.id, sam.id] } }));
    expect((await server.call("PUT", "/api/years/2025/people", { body: { revision: 1, people: [alex.id] } })).status).toBe(409);
    expect((await json<TaxYear>(server.call("GET", "/api/years/2025"))).members).toEqual([alex.id, sam.id]);
  });
});

describe("the year's facts", () => {
  it("are done once the status and each adult's province and residency are saved", async () => {
    const { alex, sam, year } = await marriedCouple();
    expect(year.issues.map((issue) => issue.code)).toEqual(["no_marital_status", "no_province", "no_residency", "no_province", "no_residency"]);
    const saved = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", {
        body: facts(1, "married", [
          { personId: alex.id, province: "ON", residentAllYear: true },
          { personId: sam.id, province: "BC", residentAllYear: true },
        ]),
      }),
    );
    expect(saved.revision).toBe(2);
    expect(saved.issues).toEqual([]);
    expect(saved.returns[0]!.steps.household).toBe("done");
  });

  it("follow the Household: married or common-law with a spouse, the other four without", async () => {
    const { alex, sam } = await marriedCouple();
    const adults = [
      { personId: alex.id, province: "ON", residentAllYear: true },
      { personId: sam.id, province: "ON", residentAllYear: true },
    ];
    const single = await server.call("PUT", "/api/years/2025/household", { body: facts(1, "single", adults) });
    expect(single.status).toBe(400);
    expect(((await single.json()) as { error: { issues: { path: string }[] } }).error.issues.map((issue) => issue.path)).toEqual(["maritalStatus"]);
    // Sam out of the year is still your partner: only your return, but still married.
    await json<TaxYear>(server.call("PUT", "/api/years/2025/people", { body: { revision: 1, people: [alex.id] } }));
    const saved = await json<TaxYear>(server.call("PUT", "/api/years/2025/household", { body: facts(2, "common_law", [adults[0]!]) }));
    expect(saved).toMatchObject({ maritalStatus: "common_law", prepareTogether: false, issues: [] });
  });

  it("ask again for a status saved before the Household changed", async () => {
    const alex = await addPerson("Alex Martin", "self");
    await startYear([alex]);
    expect((await server.call("PUT", "/api/years/2025/household", { body: facts(1, "married", [{ personId: alex.id, province: "ON", residentAllYear: true }]) })).status).toBe(400);
    await json<TaxYear>(server.call("PUT", "/api/years/2025/household", { body: facts(1, "single", [{ personId: alex.id, province: "ON", residentAllYear: true }]) }));
    const sam = await addPerson("Sam Martin", "spouse", "1987-09-15");
    const year = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    expect(year.issues).toEqual([expect.objectContaining({ code: "marital_status_mismatch", kind: "blocking", personId: sam.id })]);
    expect(year.returns[0]!.steps.household).toBe("todo");
  });

  it("name what the app can't prepare without blocking the step", async () => {
    const alex = await addPerson("Alex Martin", "self");
    await startYear([alex]);
    const saved = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", { body: facts(1, "single", [{ personId: alex.id, province: "QC", residentAllYear: true }]) }),
    );
    // Moving to or from Canada during the year is handled: only the province is named.
    expect(saved.issues.map((issue) => [issue.code, issue.kind])).toEqual([["unsupported_province", "unsupported"]]);
    expect(saved.returns[0]!.steps.household).toBe("done");
  });

  it("refuse a stale revision and keep the stored facts", async () => {
    const alex = await addPerson("Alex Martin", "self");
    await startYear([alex]);
    await json<TaxYear>(server.call("PUT", "/api/years/2025/household", { body: facts(1, "single", [{ personId: alex.id, province: "ON", residentAllYear: true }]) }));
    const stale = await server.call("PUT", "/api/years/2025/household", {
      body: facts(1, "widowed", [{ personId: alex.id, province: "BC", residentAllYear: false }]),
    });
    expect(stale.status).toBe(409);
    const stored = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    expect(stored).toMatchObject({ revision: 2, maritalStatus: "single" });
    expect(stored.adults[0]).toMatchObject({ province: "ON", residentAllYear: true });
  });

  it("refuse facts for someone who isn't an adult of the year", async () => {
    const alex = await addPerson("Alex Martin", "self");
    const sam = await addPerson("Sam Martin", "spouse");
    const jamie = await addPerson("Jamie Martin", "child", "2019-06-20");
    await startYear([alex, jamie]);
    for (const personId of [jamie.id, sam.id]) {
      const response = await server.call("PUT", "/api/years/2025/household", { body: facts(1, "married", [{ personId, province: "ON", residentAllYear: true }]) });
      expect(response.status).toBe(400);
    }
  });

  it("record who made each change", async () => {
    await marriedCouple();
    const events = await server.db.prepare("SELECT action, actor_id, access_via FROM audit_events ORDER BY rowid").all();
    expect(events.results).toEqual([
      { action: "person.added", actor_id: "user-owner", access_via: "browser" },
      { action: "person.added", actor_id: "user-owner", access_via: "browser" },
      { action: "tax_year.started", actor_id: "user-owner", access_via: "browser" },
    ]);
  });
});
