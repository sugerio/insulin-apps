import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_RETURN_RULES,
  EXPIRING_SOON_DAYS,
  fmvOn,
  openMaterialEvent,
  PLAN_RETURN_RULE_KEYS,
  presumptivelyValidOn,
  Dec,
  Rational,
  splitAdjustedPrice,
  ruleFor,
  rulesFromPayload,
  rulesToPayload,
  supersededBy,
  valuationInEffect,
  valuationStatus,
  type PlanReturnRules,
  type ValuationRecord,
} from "../../../src/app/shared/engine/index.ts";

describe("plan return rules", () => {
  it("has one default, all RETURN, frozen", () => {
    expect(PLAN_RETURN_RULE_KEYS.map((key) => DEFAULT_PLAN_RETURN_RULES[key])).toEqual(["RETURN", "RETURN", "RETURN", "RETURN", "RETURN"]);
    expect(Object.isFrozen(DEFAULT_PLAN_RETURN_RULES)).toBe(true);
  });

  it("maps each pool event to its rule (a waived vested award follows expired vested options)", () => {
    const rules: PlanReturnRules = {
      cancelledUnvestedAwards: "RETURN",
      expiredVestedOptions: "RETIRE",
      repurchasedUnvestedShares: "RETURN",
      repurchasedVestedShares: "RETIRE",
      sharesWithheldForTax: "RETIRE",
    };
    expect(ruleFor("CANCELLED_UNVESTED_AWARD", rules)).toBe("RETURN");
    expect(ruleFor("CANCELLED_VESTED_AWARD", rules)).toBe("RETIRE");
    expect(ruleFor("REPURCHASED_UNVESTED_SHARES", rules)).toBe("RETURN");
    expect(ruleFor("REPURCHASED_VESTED_SHARES", rules)).toBe("RETIRE");
    expect(ruleFor("SHARES_WITHHELD", rules)).toBe("RETIRE");
    expect(rulesFromPayload(rulesToPayload(rules))).toEqual(rules);
  });
});

const COMMON = "class-common";

function valuation(
  id: string,
  effectiveDate: string,
  expirationDate: string | null,
  events: ValuationRecord["events"] = [],
  price = "1",
  valuationType: ValuationRecord["valuationType"] = "409A",
  reportVersion: ValuationRecord["reportVersion"] = "FINAL",
): ValuationRecord {
  return { id, valuationType, reportVersion, effectiveDate, expirationDate, prices: [{ stockClassId: COMMON, pricePerShare: price }], events };
}

describe("409A status", () => {
  const v1 = valuation("v1", "2025-01-01", "2026-01-01");

  it("walks through the statuses by date", () => {
    expect(valuationStatus(v1, [v1], "2024-12-31")).toBe("not_yet_effective");
    expect(valuationStatus(v1, [v1], "2025-01-01")).toBe("presumptively_valid");
    expect(valuationStatus(v1, [v1], "2025-11-01")).toBe("presumptively_valid");
    expect(valuationStatus(v1, [v1], "2025-11-02")).toBe("expiring_soon"); // 60 days left
    expect(EXPIRING_SOON_DAYS).toBe(60);
    expect(valuationStatus(v1, [v1], "2026-01-01")).toBe("expired");
    expect(valuationStatus(valuation("v0", "2025-01-01", null), [], "2099-01-01")).toBe("presumptively_valid");
  });

  it("is superseded by a later valuation in effect, but not by a voided one", () => {
    const v2 = valuation("v2", "2025-06-01", "2026-06-01");
    expect(valuationStatus(v1, [v1, v2], "2025-05-31")).toBe("presumptively_valid");
    expect(valuationStatus(v1, [v1, v2], "2025-06-01")).toBe("superseded");
    expect(supersededBy(v1, [v1, v2], "2025-06-01")?.id).toBe("v2");
    const v2void = valuation("v2", "2025-06-01", "2026-06-01", [{ id: "e", kind: "VOIDED", eventDate: "2025-06-02", reversesEventId: null }]);
    expect(valuationStatus(v1, [v1, v2void], "2025-06-03")).toBe("presumptively_valid");
    expect(valuationStatus(v2void, [v1, v2void], "2025-06-03")).toBe("voided");
    const v3 = valuation("v3", "2025-09-01", null);
    expect(supersededBy(v1, [v1, v3, v2], "2025-09-01")?.id).toBe("v2"); // the earliest later one
  });

  it("requires review after a material event until cleared, reversed or superseded", () => {
    const flagged = valuation("v1", "2025-01-01", "2026-01-01", [{ id: "m1", kind: "MATERIAL_EVENT", eventDate: "2025-03-01", reversesEventId: null }]);
    expect(valuationStatus(flagged, [flagged], "2025-02-28")).toBe("presumptively_valid");
    expect(valuationStatus(flagged, [flagged], "2025-03-01")).toBe("review_required");
    expect(openMaterialEvent(flagged, "2025-03-01", [flagged])?.id).toBe("m1");
    const cleared = { ...flagged, events: [...flagged.events, { id: "c1", kind: "REVIEW_CLEARED" as const, eventDate: "2025-04-01", reversesEventId: null }] };
    expect(valuationStatus(cleared, [cleared], "2025-03-15")).toBe("review_required");
    expect(valuationStatus(cleared, [cleared], "2025-04-01")).toBe("presumptively_valid");
    const reversed = { ...flagged, events: [...flagged.events, { id: "reversal", kind: "EVENT_REVERSED" as const, eventDate: "2025-03-02", reversesEventId: "m1" }] };
    expect(valuationStatus(reversed, [reversed], "2025-03-02")).toBe("presumptively_valid");
    const before = valuation("v1", "2025-01-01", "2026-01-01", [{ id: "m0", kind: "MATERIAL_EVENT", eventDate: "2024-12-01", reversesEventId: null }]);
    expect(valuationStatus(before, [before], "2025-02-01")).toBe("presumptively_valid"); // priced in already
  });

  it("finds the FMV for a date, or why there is none", () => {
    expect(fmvOn([], "2025-01-01", COMMON, [])).toMatchObject({ valid: false, reason: "none" });
    expect(fmvOn([v1], "2026-02-01", COMMON, [])).toMatchObject({ valid: false, reason: "expired" });
    const flagged = valuation("v1", "2025-01-01", "2026-01-01", [{ id: "m1", kind: "MATERIAL_EVENT", eventDate: "2025-03-01", reversesEventId: null }]);
    expect(fmvOn([flagged], "2025-03-02", COMMON, [])).toMatchObject({ valid: false, reason: "review_required" });
    expect(fmvOn([v1], "2025-02-01", "other-class", [])).toMatchObject({ valid: false, reason: "no_price_for_class" });
    const ok = fmvOn([v1], "2025-02-01", COMMON, []);
    expect(ok.valid && [ok.status, ok.pricePerShare.toString()]).toEqual(["presumptively_valid", "1"]);
    const soon = fmvOn([v1], "2025-12-15", COMMON, []);
    expect(soon.valid && soon.status).toBe("expiring_soon");
    const voided = valuation("v1", "2025-01-01", null, [{ id: "x", kind: "VOIDED", eventDate: "2025-02-01", reversesEventId: null }]);
    expect(valuationInEffect([voided], "2025-03-01")).toBeNull();
    expect(valuationInEffect([v1, valuation("v2", "2025-06-01", null)], "2025-07-01")?.id).toBe("v2");
  });

  it("adjusts the FMV for the class's splits after the valuation took effect, on or before the date", () => {
    const splits = [
      { date: "2024-06-01", ratio: Rational.fromDec("10") }, // before the valuation: its price is already post-split
      { date: "2025-03-01", ratio: Rational.fromDec("3") },
      { date: "2025-09-01", ratio: Rational.fromDec("2") }, // after the date asked about
    ];
    const before = fmvOn([v1], "2025-02-28", COMMON, splits);
    expect(before.valid && [before.pricePerShare.toString(), before.splitAdjusted]).toEqual(["1", false]);
    // 1 / 3 doesn't terminate: half-even to 12 places, the storage precision.
    const after = fmvOn([v1], "2025-08-31", COMMON, splits);
    expect(after.valid && [after.pricePerShare.toString(), after.splitAdjusted]).toEqual(["0.333333333333", true]);
    const both = fmvOn([v1], "2025-09-01", COMMON, splits);
    expect(both.valid && both.pricePerShare.toString()).toBe("0.166666666667");
    expect(splitAdjustedPrice(Dec.parse("0.95"), "2025-01-01", "2025-12-31", [{ date: "2025-06-01", ratio: Rational.fromDec("2") }])).toEqual({ price: Dec.parse("0.475"), splitAdjusted: true });
  });

  it("never lets a valuation of another type price, supersede a 409A or take a flag", () => {
    const token = valuation("t1", "2025-03-01", "2026-03-01", [], "5", "OTHER");
    expect(valuationInEffect([v1, token], "2025-04-01")?.id).toBe("v1");
    expect(valuationStatus(v1, [v1, token], "2025-04-01")).toBe("presumptively_valid");
    expect(supersededBy(v1, [v1, token], "2025-04-01")).toBeNull();
    const fmv = fmvOn([v1, token], "2025-04-01", COMMON, []);
    expect(fmv.valid && [fmv.valuation.id, fmv.pricePerShare.toString()]).toEqual(["v1", "1"]);
    expect(presumptivelyValidOn([token], "2025-04-01")).toBeNull();
    expect(fmvOn([token], "2025-04-01", COMMON, [])).toMatchObject({ valid: false, reason: "none" });
    // It is in no chain: its status is `not_409a`, whatever comes later, until it is voided; it never clears a flag.
    const later = valuation("t2", "2025-06-01", null, [], "6", "OTHER");
    expect(supersededBy(token, [v1, token, later], "2025-06-01")).toBeNull();
    expect(valuationStatus(token, [v1, token, later], "2025-06-01")).toBe("not_409a");
    expect(valuationStatus(token, [token], "2024-01-01")).toBe("not_409a");
    const voidedToken = valuation("t1", "2025-03-01", "2026-03-01", [{ id: "x", kind: "VOIDED", eventDate: "2025-05-01", reversesEventId: null }], "5", "OTHER");
    expect(valuationStatus(voidedToken, [voidedToken], "2025-05-01")).toBe("voided");
    const flagged = valuation("v1", "2025-01-01", "2026-01-01", [{ id: "m1", kind: "MATERIAL_EVENT", eventDate: "2025-02-01", reversesEventId: null }]);
    expect(valuationStatus(flagged, [flagged, token], "2025-04-01")).toBe("review_required");
  });

  it("never counts a draft report: it never prices, supersedes a final report or takes a flag", () => {
    const draft = valuation("d1", "2025-03-01", "2026-03-01", [], "5", "409A", "DRAFT");
    // The final report stays in effect and prices; the draft has its own status until it is voided.
    expect(valuationInEffect([v1, draft], "2025-04-01")?.id).toBe("v1");
    expect(valuationStatus(v1, [v1, draft], "2025-04-01")).toBe("presumptively_valid");
    expect(supersededBy(v1, [v1, draft], "2025-04-01")).toBeNull();
    const fmv = fmvOn([v1, draft], "2025-04-01", COMMON, []);
    expect(fmv.valid && [fmv.valuation.id, fmv.pricePerShare.toString()]).toEqual(["v1", "1"]);
    expect(valuationStatus(draft, [v1, draft], "2025-04-01")).toBe("draft");
    expect(valuationStatus(draft, [v1, draft], "2024-01-01")).toBe("draft"); // not "valid from its date"
    // Alone, it prices nothing and takes no flag.
    expect(fmvOn([draft], "2025-04-01", COMMON, [])).toMatchObject({ valid: false, reason: "none" });
    expect(presumptivelyValidOn([draft], "2025-04-01")).toBeNull();
    // It never clears the final report's flags, and a later final report still supersedes as before.
    const flagged = valuation("v1", "2025-01-01", "2026-01-01", [{ id: "m1", kind: "MATERIAL_EVENT", eventDate: "2025-02-01", reversesEventId: null }]);
    expect(valuationStatus(flagged, [flagged, draft], "2025-04-01")).toBe("review_required");
    const voided = valuation("d1", "2025-03-01", "2026-03-01", [{ id: "x", kind: "VOIDED", eventDate: "2025-05-01", reversesEventId: null }], "5", "409A", "DRAFT");
    expect(valuationStatus(voided, [v1, voided], "2025-05-01")).toBe("voided");
  });

  it("finds no open flag on a draft or another type, whatever their own events say", () => {
    const flag = { id: "m1", kind: "MATERIAL_EVENT" as const, eventDate: "2025-04-01", reversesEventId: null, createdAt: 1 };
    const clear = { id: "c1", kind: "REVIEW_CLEARED" as const, eventDate: "2025-04-02", reversesEventId: null, createdAt: 2 };
    for (const [valuationType, reportVersion] of [["OTHER", "FINAL"], ["409A", "DRAFT"]] as const) {
      const flagged = valuation("x1", "2025-03-01", "2026-03-01", [flag], "5", valuationType, reportVersion);
      expect(openMaterialEvent(flagged, "2025-04-01", [flagged])).toBeNull();
      // Nor does its own confirmation clear anything: there is nothing to clear.
      const cleared = valuation("x1", "2025-03-01", "2026-03-01", [flag, clear], "5", valuationType, reportVersion);
      expect(openMaterialEvent(cleared, "2025-04-03", [cleared])).toBeNull();
    }
    // The same events on a final 409A: open, then cleared.
    const final = valuation("v1", "2025-03-01", "2026-03-01", [flag]);
    expect(openMaterialEvent(final, "2025-04-01", [final])?.id).toBe("m1");
    expect(openMaterialEvent(valuation("v1", "2025-03-01", "2026-03-01", [flag, clear]), "2025-04-03", [])).toBeNull();
  });

  it("keeps a flag cleared by a later valuation that took effect, even after that valuation is voided", () => {
    const flagged = valuation("v1", "2025-01-01", "2026-01-01", [{ id: "m1", kind: "MATERIAL_EVENT", eventDate: "2025-03-01", reversesEventId: null }]);
    const voidedLater = valuation("v2", "2025-05-01", "2026-05-01", [{ id: "x", kind: "VOIDED", eventDate: "2025-10-01", reversesEventId: null }]);
    expect(valuationStatus(flagged, [flagged, voidedLater], "2025-06-01")).toBe("superseded");
    // V2 counted from May to its void in October: V1 comes back without the flag V2 cleared.
    expect(valuationStatus(flagged, [flagged, voidedLater], "2025-10-02")).toBe("presumptively_valid");
    // Voided on its effective date, V2 never took effect, so it cleared nothing.
    const neverInEffect = valuation("v2", "2025-05-01", "2026-05-01", [{ id: "x", kind: "VOIDED", eventDate: "2025-05-01", reversesEventId: null }]);
    expect(valuationStatus(flagged, [flagged, neverInEffect], "2025-10-02")).toBe("review_required");
  });

  it("orders same-day events with equal ordinals by id, the same way every time", () => {
    const flag = { id: "a", kind: "MATERIAL_EVENT" as const, eventDate: "2025-03-01", reversesEventId: null, createdAt: 5 };
    const clear = { id: "b", kind: "REVIEW_CLEARED" as const, eventDate: "2025-03-01", reversesEventId: null, createdAt: 5 };
    const forward = valuation("v1", "2025-01-01", "2026-01-01", [flag, clear]);
    const backward = valuation("v1", "2025-01-01", "2026-01-01", [clear, flag]);
    expect(valuationStatus(forward, [forward], "2025-03-02")).toBe("presumptively_valid");
    expect(valuationStatus(backward, [backward], "2025-03-02")).toBe("presumptively_valid");
    const flagAfter = { ...flag, id: "c" };
    expect(valuationStatus(valuation("v1", "2025-01-01", "2026-01-01", [clear, flagAfter]), [], "2025-03-02")).toBe("review_required");
  });
});
