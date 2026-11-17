import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Person, TaxYear } from "#shared";
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

async function marriedCouple() {
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025 } }), 201);
  const alex = await addPerson("Alex Martin", "self");
  const sam = await addPerson("Sam Martin", "spouse", "1987-09-15");
  return { alex, sam };
}

describe("tax years", () => {
  it("starts a supported year once; starting it again returns it unchanged", async () => {
    const first = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025 } }), 201);
    expect(first).toMatchObject({ year: 2025, revision: 1, maritalStatus: null, prepareTogether: true });
    expect(first.steps.household).toBe("todo");
    expect(first.steps.upload).toBe("not_built");
    const again = await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025 } }), 200);
    expect(again.revision).toBe(1);
  });

  it("refuses a year the app has no rules for", async () => {
    const response = await server.call("POST", "/api/years", { body: { year: 2019 } });
    expect(response.status).toBe(400);
    expect((await server.call("GET", "/api/years/2019")).status).toBe(404);
  });

  it("lists the years with their filers and the household's people", async () => {
    await marriedCouple();
    const list = await json<{ years: { year: number; filers: string[] }[]; people: Person[]; supportedYears: number[] }>(server.call("GET", "/api/years"));
    expect(list.supportedYears).toEqual([2025]);
    expect(list.people.map((person) => person.name)).toEqual(["Alex Martin", "Sam Martin"]);
    // Marital status not chosen yet: only the person preparing files.
    expect(list.years).toEqual([expect.objectContaining({ year: 2025, filers: ["Alex Martin"] })]);
  });
});

describe("people", () => {
  it("keeps one 'you' and one spouse per household", async () => {
    await marriedCouple();
    const secondSelf = await server.call("POST", "/api/people", { body: { name: "Another Me", relationship: "self", birthDate: "1990-01-01" } });
    expect(secondSelf.status).toBe(409);
    const secondSpouse = await server.call("POST", "/api/people", { body: { name: "Another Spouse", relationship: "spouse", birthDate: "1990-01-01" } });
    expect(secondSpouse.status).toBe(409);
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

  it("removes a person with their facts in every year", async () => {
    const { alex, sam } = await marriedCouple();
    await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", {
        body: {
          revision: 1,
          maritalStatus: "married",
          prepareTogether: true,
          adults: [
            { personId: alex.id, province: "ON", residentAllYear: true },
            { personId: sam.id, province: "ON", residentAllYear: true },
          ],
        },
      }),
    );
    expect((await server.call("DELETE", `/api/people/${sam.id}`)).status).toBe(204);
    const returns = await server.db.prepare("SELECT person_id FROM returns").all<{ person_id: string }>();
    expect(returns.results.map((row) => row.person_id)).toEqual([alex.id]);
  });
});

describe("the household step", () => {
  it("is done once the status and each filer's province and residency are saved", async () => {
    const { alex, sam } = await marriedCouple();
    const before = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    expect(before.issues.map((issue) => issue.code)).toEqual(["no_marital_status", "no_province", "no_residency"]);

    const saved = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", {
        body: {
          revision: 1,
          maritalStatus: "married",
          prepareTogether: true,
          adults: [
            { personId: alex.id, province: "ON", residentAllYear: true },
            { personId: sam.id, province: "BC", residentAllYear: true },
          ],
        },
      }),
    );
    expect(saved.revision).toBe(2);
    expect(saved.issues).toEqual([]);
    expect(saved.steps.household).toBe("done");
    expect(saved.adults).toEqual([
      { personId: alex.id, province: "ON", residentAllYear: true, prepared: true },
      { personId: sam.id, province: "BC", residentAllYear: true, prepared: true },
    ]);
  });

  it("asks only for the person preparing when the returns aren't prepared together", async () => {
    const { alex } = await marriedCouple();
    const saved = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", {
        body: { revision: 1, maritalStatus: "married", prepareTogether: false, adults: [{ personId: alex.id, province: "AB", residentAllYear: true }] },
      }),
    );
    expect(saved.steps.household).toBe("done");
    expect(saved.adults.find((adult) => adult.personId !== alex.id)?.prepared).toBe(false);
  });

  it("names what it can't prepare without blocking the step", async () => {
    await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025 } }), 201);
    const alex = await addPerson("Alex Martin", "self");
    const saved = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", {
        body: { revision: 1, maritalStatus: "single", prepareTogether: true, adults: [{ personId: alex.id, province: "QC", residentAllYear: false }] },
      }),
    );
    expect(saved.issues.map((issue) => [issue.code, issue.kind])).toEqual([
      ["unsupported_province", "unsupported"],
      ["part_year_resident", "unsupported"],
    ]);
    expect(saved.steps.household).toBe("done");
  });

  it("asks for the spouse when married and preparing together, and flags a spouse under a single status", async () => {
    await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025 } }), 201);
    const alex = await addPerson("Alex Martin", "self");
    const adults = [{ personId: alex.id, province: "ON" as const, residentAllYear: true }];
    const married = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", { body: { revision: 1, maritalStatus: "married", prepareTogether: true, adults } }),
    );
    expect(married.issues.map((issue) => issue.code)).toEqual(["no_spouse"]);
    await addPerson("Sam Martin", "spouse");
    const single = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", { body: { revision: 2, maritalStatus: "single", prepareTogether: true, adults } }),
    );
    expect(single.issues.map((issue) => issue.code)).toEqual(["spouse_without_partner_status"]);
  });

  it("refuses a stale revision and keeps the stored facts as they were", async () => {
    const { alex } = await marriedCouple();
    const first = { revision: 1, maritalStatus: "married", prepareTogether: false, adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] };
    await json<TaxYear>(server.call("PUT", "/api/years/2025/household", { body: first }));
    const stale = await server.call("PUT", "/api/years/2025/household", {
      body: { ...first, maritalStatus: "single", adults: [{ personId: alex.id, province: "BC", residentAllYear: false }] },
    });
    expect(stale.status).toBe(409);
    const stored = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    expect(stored).toMatchObject({ revision: 2, maritalStatus: "married" });
    expect(stored.adults[0]).toMatchObject({ province: "ON", residentAllYear: true });
  });

  it("refuses facts for someone who isn't an adult of the household", async () => {
    await marriedCouple();
    const jamie = await addPerson("Jamie Martin", "child", "2019-06-20");
    const response = await server.call("PUT", "/api/years/2025/household", {
      body: { revision: 1, maritalStatus: "married", prepareTogether: true, adults: [{ personId: jamie.id, province: "ON", residentAllYear: true }] },
    });
    expect(response.status).toBe(400);
  });

  it("records who made each change", async () => {
    await marriedCouple();
    const events = await server.db.prepare("SELECT action, actor_id, access_via FROM audit_events ORDER BY rowid").all();
    expect(events.results).toEqual([
      { action: "tax_year.started", actor_id: "user-owner", access_via: "browser" },
      { action: "person.added", actor_id: "user-owner", access_via: "browser" },
      { action: "person.added", actor_id: "user-owner", access_via: "browser" },
    ]);
  });
});
