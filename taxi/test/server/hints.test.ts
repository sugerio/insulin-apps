import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Estimate, HintList, Person, TaxYear } from "#shared";
import { Evaluation } from "../../src/app/shared/engine/evaluate.ts";
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

/** A married couple in Ontario, $60,000 each on a T4 and $150 of donations each: pooling saves $20.60. */
async function couple() {
  const alex = await addPerson("Alex Martin", "self", "1985-04-02");
  const sam = await addPerson("Sam Martin", "spouse", "1987-09-15");
  await json<TaxYear>(server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id, sam.id] } }), 201);
  let year = await json<TaxYear>(
    server.call("PUT", "/api/years/2025/household", {
      body: { revision: 1, maritalStatus: "married", adults: [alex, sam].map((person) => ({ personId: person.id, province: "ON", residentAllYear: true })) },
    }),
  );
  for (const person of [alex, sam]) {
    year = await json<TaxYear>(
      server.call("POST", "/api/years/2025/slips", { body: { revision: year.revision, personId: person.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } } }),
      201,
    );
    year = await json<TaxYear>(server.call("PUT", "/api/years/2025/answers", { body: { revision: year.revision, personId: person.id, answers: { donations: "150" } } }));
  }
  return { alex, sam, revision: year.revision };
}

const hints = () => json<HintList>(server.call("GET", "/api/years/2025/hints"));
const decide = (hint: string, body: object, as?: typeof VIEWER) => server.call("POST", `/api/years/2025/hints/${hint}`, { body, ...(as ? { as } : {}) });
const estimate = () => json<Estimate>(server.call("GET", "/api/years/2025/estimate"));

describe("hints", () => {
  it("offer a saving worked out with and without it, and things to know", async () => {
    const { alex, sam } = await couple();
    const list = await hints();
    expect(list.hints).toContainEqual(
      expect.objectContaining({ id: "poolDonations", personId: alex.id, kind: "saving", effect: "20.6", state: "open", amount: { label: "Your spouse's or partner's donations", value: "150" } }),
    );
    expect(list.hints.filter((hint) => hint.id === "poolDonations")).toHaveLength(1);
    expect(list.hints.filter((hint) => hint.id === "interestWithoutSlip").map((hint) => hint.personId).sort()).toEqual([alex.id, sam.id].sort());
    // A viewer reads them too.
    expect((await server.call("GET", "/api/years/2025/hints", { as: VIEWER })).status).toBe(200);
  });

  it("accepting a saving saves its answers; undoing it puts them back", async () => {
    const { alex, sam, revision } = await couple();
    const accepted = await json<TaxYear>(decide("poolDonations", { revision, personId: alex.id, decision: "accept" }));
    expect(accepted.revision).toBe(revision + 1);
    const after = await estimate();
    expect(after.input.answers[alex.id]).toMatchObject({ donations: "150", claimSpouseDonations: true });
    expect(after.input.answers[sam.id]).toMatchObject({ donations: "150", claimSpouseDonations: false });
    const evaluation = new Evaluation(rulesFor(2025)!, after.input);
    expect(evaluation.line(alex.id, "S9.5").value?.toString()).toBe("300");
    expect(evaluation.line(sam.id, "S9.5").value?.toString()).toBe("0");
    expect((await hints()).hints.filter((hint) => hint.id === "poolDonations")).toEqual([
      expect.objectContaining({ personId: alex.id, state: "applied", effect: "20.6" }),
    ]);
    // Applied, it can't be dismissed; only undone.
    expect((await decide("poolDonations", { revision: accepted.revision, personId: alex.id, decision: "dismiss" })).status).toBe(409);

    await json<TaxYear>(decide("poolDonations", { revision: accepted.revision, personId: alex.id, decision: "undo" }));
    const undone = await estimate();
    expect(undone.input.answers[alex.id]).toEqual({ donations: "150" });
    expect(undone.input.answers[sam.id]).toEqual({ donations: "150" });
    expect((await hints()).hints.find((hint) => hint.id === "poolDonations")).toMatchObject({ state: "open" });
  });

  it("dismissing a hint keeps it, marked dismissed, until undone", async () => {
    const { sam, revision } = await couple();
    const dismissed = await json<TaxYear>(decide("interestWithoutSlip", { revision, personId: sam.id, decision: "dismiss" }));
    expect((await hints()).hints.find((hint) => hint.id === "interestWithoutSlip" && hint.personId === sam.id)).toMatchObject({ state: "dismissed" });
    await json<TaxYear>(decide("interestWithoutSlip", { revision: dismissed.revision, personId: sam.id, decision: "undo" }));
    expect((await hints()).hints.find((hint) => hint.id === "interestWithoutSlip" && hint.personId === sam.id)).toMatchObject({ state: "open" });
  });

  it("refuse what can't be decided", async () => {
    const { alex, sam, revision } = await couple();
    // Something to know isn't accepted; a saving offered on the other return, an unknown hint and nothing to undo.
    expect((await decide("interestWithoutSlip", { revision, personId: alex.id, decision: "accept" })).status).toBe(400);
    expect((await decide("poolDonations", { revision, personId: sam.id, decision: "accept" })).status).toBe(409);
    expect((await decide("noSuchHint", { revision, personId: alex.id, decision: "dismiss" })).status).toBe(404);
    expect((await decide("poolDonations", { revision, personId: alex.id, decision: "undo" })).status).toBe(404);
    // A stale revision and a viewer.
    expect((await decide("poolDonations", { revision: revision - 1, personId: alex.id, decision: "accept" })).status).toBe(409);
    expect((await decide("poolDonations", { revision, personId: alex.id, decision: "accept" }, VIEWER)).status).toBe(403);
  });

  it("go with a person taken out of the year", async () => {
    const { alex, sam, revision } = await couple();
    const dismissed = await json<TaxYear>(decide("interestWithoutSlip", { revision, personId: sam.id, decision: "dismiss" }));
    await json<TaxYear>(server.call("PUT", "/api/years/2025/people", { body: { revision: dismissed.revision, people: [alex.id] } }));
    await json<TaxYear>(server.call("PUT", "/api/years/2025/people", { body: { revision: dismissed.revision + 1, people: [alex.id, sam.id] } }));
    expect((await hints()).hints.find((hint) => hint.id === "interestWithoutSlip" && hint.personId === sam.id)).toMatchObject({ state: "open" });
  });
});
