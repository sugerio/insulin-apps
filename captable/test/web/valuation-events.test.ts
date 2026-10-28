import "./setup.ts";
import { describe, expect, it } from "vitest";
import { engine, type api } from "#shared";
import { classPrice, counts409A, currentValuation, materialEvents, openMaterialEvents } from "../../src/app/lib/valuations.ts";
import { IDS, TODAY, uuid, valuation } from "./support/acme.ts";

// 409A material events resolve by chronology: a written confirmation clears
// only the events before it, a later valuation only those dated before it took effect, and a reversed event counts
// for nothing.

let next = 0;
function event(kind: api.ValuationEvent["kind"], eventDate: string, overrides: Partial<api.ValuationEvent> = {}): api.ValuationEvent {
  next += 1;
  return {
    id: uuid(20, next), kind, eventDate, description: `${kind} ${next}`, documentId: null, reversesEventId: null,
    createdBy: "Rachel Ostrowski", createdAt: Date.UTC(2026, 0, 1) + next * 60_000, ...overrides,
  };
}

const resolutions = (states: ReturnType<typeof materialEvents>) => states.map((state) => [state.event.eventDate, state.resolution?.kind ?? "open", state.resolution?.date ?? null]);

describe("material event chronology", () => {
  it("lets a confirmation clear only the events before it, so a later event needs review again", () => {
    const current = valuation({
      status: "review_required",
      events: [event("MATERIAL_EVENT", "2026-03-01"), event("REVIEW_CLEARED", "2026-04-01"), event("MATERIAL_EVENT", "2026-06-01")],
    });
    expect(resolutions(materialEvents(current, [current], TODAY))).toEqual([
      ["2026-03-01", "confirmation", "2026-04-01"],
      ["2026-06-01", "open", null],
    ]);
    expect(openMaterialEvents(current, [current], TODAY).map((item) => item.eventDate)).toEqual(["2026-06-01"]);
  });

  it("orders same-day events by when they were recorded", () => {
    const confirmation = event("REVIEW_CLEARED", "2026-05-01");
    const flaggedAfter = event("MATERIAL_EVENT", "2026-05-01");
    const flaggedBefore = event("MATERIAL_EVENT", "2026-05-01", { createdAt: confirmation.createdAt - 1 });
    const current = valuation({ status: "review_required", events: [confirmation, flaggedAfter, flaggedBefore] });
    const states = materialEvents(current, [current], TODAY);
    expect(states.map((state) => [state.event.id, state.resolution?.kind ?? "open"])).toEqual([
      [flaggedBefore.id, "confirmation"],
      [flaggedAfter.id, "open"],
    ]);
  });

  it("ignores reversed events: a reversed flag is not listed and a reversed confirmation clears nothing", () => {
    const flag = event("MATERIAL_EVENT", "2026-02-01");
    const mistaken = event("MATERIAL_EVENT", "2026-02-10");
    const confirmation = event("REVIEW_CLEARED", "2026-03-01");
    const current = valuation({
      status: "review_required",
      events: [flag, mistaken, event("EVENT_REVERSED", "2026-02-11", { reversesEventId: mistaken.id }), confirmation, event("EVENT_REVERSED", "2026-03-02", { reversesEventId: confirmation.id })],
    });
    expect(resolutions(materialEvents(current, [current], TODAY))).toEqual([["2026-02-01", "open", null]]);
  });

  it("counts a later valuation only once it took effect after the event", () => {
    const older = valuation({ id: IDS.v4, effectiveDate: "2025-03-15", status: "superseded", events: [event("MATERIAL_EVENT", "2025-06-01"), event("MATERIAL_EVENT", "2025-12-01")] });
    const newer = valuation({ effectiveDate: "2025-11-05" });
    expect(resolutions(materialEvents(older, [older, newer], TODAY))).toEqual([
      ["2025-06-01", "valuation", "2025-11-05"],
      // flagged after the newer valuation took effect: that valuation can't have accounted for it
      ["2025-12-01", "open", null],
    ]);
    const future = valuation({ id: uuid(8, 9), effectiveDate: "2026-12-01", status: "presumptively_valid" });
    const current = valuation({ status: "review_required", events: [event("MATERIAL_EVENT", "2026-09-01")] });
    expect(resolutions(materialEvents(current, [current, future], TODAY))).toEqual([["2026-09-01", "open", null]]);
  });

  it("never contradicts the computed status: a valuation in review keeps its newest event open", () => {
    const current = valuation({ status: "review_required", events: [event("MATERIAL_EVENT", "2026-01-10"), event("REVIEW_CLEARED", "2026-02-01")] });
    expect(resolutions(materialEvents(current, [current], TODAY))).toEqual([["2026-01-10", "open", null]]);
  });
});

describe("class prices", () => {
  const classes = [
    { id: IDS.seed, classType: "PREFERRED" },
    { id: IDS.common, classType: "COMMON" },
  ] as unknown as api.StockClass[];

  it("finds the common price by class id, whatever the order of the prices", () => {
    const priced = valuation({ prices: [{ stockClassId: IDS.seed, pricePerShare: "1.6" }, { stockClassId: IDS.common, pricePerShare: "0.95" }] });
    expect(classPrice(priced, classes)).toBe("0.95");
    expect(classPrice(priced, classes, IDS.seed)).toBe("1.6");
  });

  it("returns nothing rather than guessing when the class isn't priced or isn't known", () => {
    const preferredOnly = valuation({ prices: [{ stockClassId: IDS.seed, pricePerShare: "1.6" }] });
    expect(classPrice(preferredOnly, classes)).toBeNull();
    expect(classPrice(preferredOnly, [])).toBeNull();
  });
});

describe("only a final 409A counts (the engine's isFinal409A)", () => {
  // As the server reads them now: a draft report has status draft, another valuation type not_409a.
  const final = valuation({ status: "review_required", events: [event("MATERIAL_EVENT", "2026-02-01")] });
  const newerDraft = valuation({ id: uuid(8, 8), name: "Oct 2026 Draft", reportVersion: "DRAFT", effectiveDate: "2026-10-01", expirationDate: "2027-10-01", status: "draft", presumptivelyValidUntil: null });
  const newerOther = valuation({ id: uuid(8, 7), name: "Sep 2026 Token Valuation", valuationType: "OTHER", effectiveDate: "2026-09-01", expirationDate: null, status: "not_409a", presumptivelyValidUntil: null });

  it("agrees with the engine's rule for every type and report version", () => {
    for (const valuationType of ["409A", "OTHER"] as const) {
      for (const reportVersion of ["FINAL", "DRAFT"] as const) {
        expect(counts409A({ valuationType, reportVersion })).toBe(engine.isFinal409A({ valuationType, reportVersion } as Parameters<typeof engine.isFinal409A>[0]));
      }
    }
  });

  it("keeps the final 409A in effect when a newer draft or not_409a valuation exists", () => {
    expect(currentValuation([final, newerDraft, newerOther], TODAY)?.id).toBe(final.id);
    expect(currentValuation([newerDraft, newerOther], TODAY)).toBeNull();
  });

  it("never lets a newer draft or not_409a valuation resolve a material event", () => {
    expect(resolutions(materialEvents(final, [final, newerDraft, newerOther], TODAY))).toEqual([["2026-02-01", "open", null]]);
    // And neither one carries events of its own as 409A flags.
    expect(materialEvents({ ...newerDraft, events: [event("MATERIAL_EVENT", "2026-10-05")] }, [final, newerDraft], TODAY)).toEqual([]);
  });
});
