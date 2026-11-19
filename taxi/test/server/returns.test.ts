import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Estimate, Person, SlipList, TaxYear } from "#shared";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
import { VIEWER, startServer, type TestServer } from "../support/server.ts";

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

const addPerson = (name: string, relationship: string, birthDate: string) =>
  json<Person>(server.call("POST", "/api/people", { body: { name, relationship, birthDate } }), 201);

/** Alex (and Sam) in Ontario, step 1 saved: the year is at revision 2. */
async function year(withSam = false) {
  const alex = await addPerson("Alex Martin", "self", "1985-04-02");
  const sam = await addPerson("Sam Martin", "spouse", "1987-09-15");
  const people = withSam ? [alex, sam] : [alex];
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: people.map((person) => person.id) } }), 201);
  const saved = await json<TaxYear>(
    server.call("PUT", "/api/years/2025/household", {
      body: { revision: 1, maritalStatus: "married", adults: people.map((person) => ({ personId: person.id, province: "ON", residentAllYear: true })) },
    }),
  );
  return { alex, sam, revision: saved.revision };
}

const T4 = { 14: "60000.00", 16: "3361.75", 18: "984", 22: "9000" };
const estimate = () => json<Estimate>(server.call("GET", "/api/years/2025/estimate"));
const lineOf = (result: Estimate, personId: string, id: string) =>
  result.result.people.find((person) => person.personId === personId)!.lines.find((line) => line.id === id)!;

describe("an adult's answers", () => {
  it("are saved as given, checked against each question, and cleared with null", async () => {
    const { alex, revision } = await year();
    const saved = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/answers", { body: { revision, personId: alex.id, answers: { rrspDeduction: "5000.50", hasSelfEmployment: false } } }),
    );
    expect(saved.revision).toBe(revision + 1);
    expect((await estimate()).input.answers).toEqual({ [alex.id]: { rrspDeduction: "5000.5", hasSelfEmployment: false } });

    const wrong = await server.call("PUT", "/api/years/2025/answers", {
      body: { revision: saved.revision, personId: alex.id, answers: { rrspDeduction: "lots", hasSelfEmployment: "no", favouriteColour: "blue" } },
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { issues: { path: string }[] } }).error.issues.map((issue) => issue.path)).toEqual([
      "answers.rrspDeduction",
      "answers.hasSelfEmployment",
      "answers.favouriteColour",
    ]);

    await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: saved.revision, personId: alex.id, answers: { rrspDeduction: null } } }));
    expect((await estimate()).input.answers).toEqual({ [alex.id]: { hasSelfEmployment: false } });
  });

  it("name what the app doesn't handle once answered so", async () => {
    const { alex, revision } = await year();
    await json<TaxYear>(
      server.call("PUT", "/api/years/2025/answers", { body: { revision, personId: alex.id, answers: { soldProperty: true, propertyUse: "flipped" } } }),
    );
    const result = await estimate();
    expect(result.result.people[0]!.unhandled).toContain("A home owned less than 12 months (a flipped property) is business income, which this app doesn't handle yet");
    expect(lineOf(result, alex.id, "T1.15000").status).toBe("missing");
  });

  it("ask a group's parts once it applies, and take a percent from 0 to 100", async () => {
    const { alex, revision } = await year();
    const saved = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision, personId: alex.id, answers: { hasRentalIncome: true } } }));
    // The rents and expenses are now needed, so the total income waits for them.
    const result = await estimate();
    expect(result.result.people[0]!.missing.map((item) => item.question)).toEqual(expect.arrayContaining(["rentalGross", "rentalExpenses"]));
    expect(lineOf(result, alex.id, "T1.15000").status).toBe("missing");
    const wrong = await server.call("PUT", "/api/years/2025/answers", { body: { revision: saved.revision, personId: alex.id, answers: { homeOfficeShare: "120" } } });
    expect(wrong.status).toBe(400);
    await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: saved.revision, personId: alex.id, answers: { homeOfficeShare: "12.5" } } }));
  });

  it("refuse a stale revision, someone outside the year, and a viewer", async () => {
    const { alex, sam, revision } = await year();
    const body = (overrides: object) => ({ body: { revision, personId: alex.id, answers: { donations: "100" }, ...overrides } });
    expect((await server.call("PUT", "/api/years/2025/answers", body({ revision: revision - 1 }))).status).toBe(409);
    expect((await server.call("PUT", "/api/years/2025/answers", body({ personId: sam.id }))).status).toBe(400);
    expect((await server.call("PUT", "/api/years/2025/answers", { as: VIEWER, ...body({}) })).status).toBe(403);
  });
});

describe("slips", () => {
  it("are added unconfirmed, read by the engine, and confirmed all at once", async () => {
    const { alex, revision } = await year();
    const added = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: T4 } }), 201);
    expect(added.returns[0]!.steps.confirm).toBe("todo");
    const list = await json<SlipList>(server.call("GET", "/api/years/2025/slips", { as: VIEWER }));
    expect(list.slips).toEqual([
      expect.objectContaining({ personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 16: "3361.75", 18: "984", 22: "9000" }, status: "unconfirmed" }),
    ]);
    expect(lineOf(await estimate(), alex.id, "T1.15000")).toMatchObject({ value: "60000" });

    const confirmed = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: added.revision } }));
    expect(confirmed.returns[0]!.steps.confirm).toBe("done");
    const [slip] = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    expect(slip).toMatchObject({ status: "confirmed", confirmedAt: 1_767_225_600_000 });

    // Any change sends it back to unconfirmed.
    const changed = await json<TaxYear>(server.call("PATCH", `/api/years/2025/slips/${slip!.id}`, { body: { revision: confirmed.revision, boxes: { ...T4, 22: "9500" } } }));
    expect(changed.returns[0]!.steps.confirm).toBe("todo");
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips[0]).toMatchObject({ status: "unconfirmed", boxes: expect.objectContaining({ 22: "9500" }) });

    const removed = await json<TaxYear>(server.call("DELETE", `/api/years/2025/slips/${slip!.id}`, { body: { revision: changed.revision } }));
    expect(removed.revision).toBe(changed.revision + 1);
    expect((await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips).toEqual([]);
  });

  it("refuse a type or box the year's rules don't have", async () => {
    const { alex, revision } = await year();
    const add = (type: string, boxes: object) => server.call("POST", "/api/years/2025/slips", { body: { revision, personId: alex.id, type, issuer: "Maple Corp", boxes } });
    expect((await add("W2", { 1: "10" })).status).toBe(400);
    const badBox = await add("T4", { 14: "10", 99: "5" });
    expect(badBox.status).toBe(400);
    expect(((await badBox.json()) as { error: { issues: { path: string }[] } }).error.issues).toEqual([{ path: "boxes.99", message: "T4 has no box 99" }]);
    expect((await add("T4", { 14: "-10" })).status).toBe(400);
  });

  it("leave the year with the person taken out of it", async () => {
    const { alex, sam, revision } = await year(true);
    let current = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision, personId: sam.id, type: "T4", issuer: "Cafe", boxes: { 14: "9000" } } }), 201);
    current = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: current.revision, personId: sam.id, answers: { donations: "50" } } }));
    await json<TaxYear>(server.call("PUT", "/api/years/2025/people", { body: { revision: current.revision, people: [alex.id] } }));
    const left = await estimate();
    expect(left.input.slips).toEqual([]);
    expect(left.input.answers).toEqual({});
  });
});

/** A module's questions answered as for a return with none of it: each yes/no question no, each amount its default. */
function noneOf(module: string, except: string[] = []): Record<string, string | boolean> {
  return Object.fromEntries(
    [...rulesFor(2025)!.questions.values()]
      .filter((question) => question.module === module && !question.parent && !except.includes(question.id))
      .flatMap((question) => (question.type === "boolean" ? [[question.id, false]] : question.default !== undefined ? [[question.id, question.default]] : [])),
  );
}

describe("the steps", () => {
  it("are done once their questions are answered and the slips confirmed", async () => {
    const { alex, revision } = await year();
    const put = (current: number, answers: Record<string, string | boolean | null>) =>
      json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: current, personId: alex.id, answers } }));
    const income = noneOf("income");
    let current = await put(revision, income);
    // Alex is married and Sam's return isn't prepared here: Sam's net income is asked on Personal info.
    expect(current.returns[0]!.steps).toEqual({
      household: "todo",
      upload: "todo",
      income: "done",
      deductions: "todo",
      credits: "todo",
      confirm: "todo",
      finish: "todo",
    });
    current = await put(current.revision, noneOf("deductions", ["hasMovingExpenses"]));
    // Moving expenses not answered yet.
    expect(current.returns[0]!.steps.deductions).toBe("todo");
    current = await put(current.revision, { hasMovingExpenses: false });
    expect(current.returns[0]!.steps.deductions).toBe("done");
    current = await put(current.revision, noneOf("credits"));
    expect(current.returns[0]!.steps.credits).toBe("done");
    current = await put(current.revision, { spouseNetIncome: "12000" });
    expect(current.returns[0]!.steps.household).toBe("done");
  });

  it("count a slip found as the answer to its question, and a yes without the slip as missing", async () => {
    const { alex, revision } = await year();
    const notHandled = noneOf("income", ["hasEmploymentIncome", "hasInvestmentIncome", "hasTrustIncome", "hasSoldInvestments"]);
    let current = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/answers", {
        body: { revision, personId: alex.id, answers: { ...notHandled, hasInvestmentIncome: false, hasTrustIncome: false, hasSoldInvestments: false, hasEmploymentIncome: true } },
      }),
    );
    // A T4 is said to exist but isn't here yet.
    expect(current.returns[0]!.steps.income).toBe("todo");
    current = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: current.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: T4 } }), 201);
    expect(current.returns[0]!.steps.income).toBe("done");
    // With the T4 here, the employment question needs no answer at all.
    current = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: current.revision, personId: alex.id, answers: { hasEmploymentIncome: null } } }));
    expect(current.returns[0]!.steps.income).toBe("done");
  });

  it("are each adult's own: one return's slips and facts don't hold up the other's", async () => {
    const { alex, sam } = await year(true);
    let current = await json<TaxYear>(server.call("GET", "/api/years/2025"));
    const stepOf = (view: TaxYear, personId: string, step: keyof TaxYear["returns"][number]["steps"]) => view.returns.find((each) => each.personId === personId)!.steps[step];
    current = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: current.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: T4 } }), 201);
    current = await json<TaxYear>(server.call("POST", "/api/years/2025/slips", { body: { revision: current.revision, personId: sam.id, type: "T4", issuer: "Cafe", boxes: { 14: "9000" } } }), 201);
    current = await json<TaxYear>(server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: current.revision, personId: alex.id } }));
    expect([stepOf(current, alex.id, "confirm"), stepOf(current, sam.id, "confirm")]).toEqual(["done", "todo"]);
    const slips = (await json<SlipList>(server.call("GET", "/api/years/2025/slips"))).slips;
    expect(Object.fromEntries(slips.map((slip) => [slip.personId, slip.status]))).toEqual({ [alex.id]: "confirmed", [sam.id]: "unconfirmed" });
    // Sam's province missing holds up only Sam's first step; a status missing would hold up both.
    current = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", { body: { revision: current.revision, maritalStatus: "married", adults: [{ personId: sam.id, province: null, residentAllYear: true }] } }),
    );
    expect([stepOf(current, alex.id, "household"), stepOf(current, sam.id, "household")]).toEqual(["done", "todo"]);
    current = await json<TaxYear>(
      server.call("PUT", "/api/years/2025/household", { body: { revision: current.revision, maritalStatus: null, adults: [{ personId: sam.id, province: "ON", residentAllYear: true }] } }),
    );
    expect([stepOf(current, alex.id, "household"), stepOf(current, sam.id, "household")]).toEqual(["todo", "todo"]);
    // Confirming for someone outside the year is refused.
    expect((await server.call("POST", "/api/years/2025/slips/confirm", { body: { revision: current.revision, personId: crypto.randomUUID() } })).status).toBe(400);
  });
});
