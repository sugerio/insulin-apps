import { describe, expect, it } from "vitest";
import { grantEquityCompensationSchema } from "../../../src/app/shared/api/commands.ts";
import { VESTING_PERIOD_MONTHS, vestingDefinitionSchema, vestingPreviewRequestSchema } from "../../../src/app/shared/api/equity.ts";
import { ENDPOINT_EXAMPLES } from "./endpoint-examples.ts";

// The tranche generator accepts whole periods and cliffs that are whole periods no
// longer than the schedule, explicit tables in date order that add up to the quantity.

const schedule = (frequency: string, totalMonths: number, cliffMonths: number | null) => ({
  type: "SCHEDULE",
  totalMonths,
  frequency,
  cliff: cliffMonths === null ? null : { months: cliffMonths, quantityRule: "RATABLE" },
  dayRule: "SAME_DAY_CLAMPED",
});
const valid = (definition: unknown) => vestingDefinitionSchema.safeParse(definition).success;

describe("vesting schedules", () => {
  it("use the generator's periods", () => {
    expect(VESTING_PERIOD_MONTHS).toEqual({ MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12 });
  });

  it("monthly: any cliff up to the duration", () => {
    expect(valid(schedule("MONTHLY", 48, 12))).toBe(true);
    expect(valid(schedule("MONTHLY", 48, 1))).toBe(true);
    expect(valid(schedule("MONTHLY", 48, 48))).toBe(true);
    expect(valid(schedule("MONTHLY", 48, null))).toBe(true);
    expect(valid(schedule("MONTHLY", 48, 49))).toBe(false);
  });

  it("quarterly: whole quarters for the duration and the cliff", () => {
    expect(valid(schedule("QUARTERLY", 48, 12))).toBe(true);
    expect(valid(schedule("QUARTERLY", 48, 6))).toBe(true);
    expect(valid(schedule("QUARTERLY", 48, 5))).toBe(false);
    expect(valid(schedule("QUARTERLY", 50, 12))).toBe(false);
    expect(valid(schedule("QUARTERLY", 12, 15))).toBe(false);
  });

  it("annually: whole years for the duration and the cliff", () => {
    expect(valid(schedule("ANNUALLY", 48, 12))).toBe(true);
    expect(valid(schedule("ANNUALLY", 48, 6))).toBe(false);
    expect(valid(schedule("ANNUALLY", 18, null))).toBe(false);
    expect(valid(schedule("ANNUALLY", 24, 36))).toBe(false);
  });

  it("keep the schema's range for the duration", () => {
    expect(valid(schedule("MONTHLY", 0, null))).toBe(false);
    expect(valid(schedule("MONTHLY", 240, 12))).toBe(true);
    expect(valid(schedule("MONTHLY", 252, 12))).toBe(false);
    expect(valid(schedule("MONTHLY", 48, 0))).toBe(false); // no cliff is null, not 0
  });

  it("list explicit tranches in date order", () => {
    const events = [
      { date: "2027-12-10", quantity: "12000" },
      { date: "2028-12-10", quantity: "36000" },
    ];
    expect(valid({ type: "EXPLICIT", events })).toBe(true);
    expect(valid({ type: "EXPLICIT", events: [events[1], events[0]] })).toBe(false);
  });
});

describe("vesting previews", () => {
  const preview = (definition: unknown, quantity = "48000") =>
    vestingPreviewRequestSchema.safeParse({ definition, quantity, vestingStartDate: "2026-12-10" }).success;

  it("need explicit tables to add up to the quantity, exactly", () => {
    const events = [
      { date: "2027-12-10", quantity: "0.5" },
      { date: "2028-12-10", quantity: "47999.5" },
    ];
    expect(preview({ type: "EXPLICIT", events })).toBe(true);
    expect(preview({ type: "EXPLICIT", events: [events[0]] })).toBe(false);
    expect(preview({ type: "EXPLICIT", events }, "48000.000000000001")).toBe(false);
  });

  it("refuse an explicit cliff above the quantity", () => {
    const withCliff = (explicitQuantity: string) => ({
      ...schedule("MONTHLY", 48, 12),
      cliff: { months: 12, quantityRule: { explicitQuantity } },
    });
    expect(preview(withCliff("12000"))).toBe(true);
    expect(preview(withCliff("48000"))).toBe(true);
    expect(preview(withCliff("48001"))).toBe(false);
  });
});

describe("grants with explicit tranches", () => {
  it("need them in date order", () => {
    const body = ENDPOINT_EXAMPLES.grantEquityCompensation.body as Record<string, unknown> & { vesting: Record<string, unknown> };
    const explicit = (dates: string[]) => ({ ...body, vesting: { ...body.vesting, terms: { explicit: dates.map((date) => ({ date, quantity: "24000" })) } } });
    expect(grantEquityCompensationSchema.safeParse(explicit(["2027-12-10", "2028-12-10"])).success).toBe(true);
    expect(grantEquityCompensationSchema.safeParse(explicit(["2028-12-10", "2027-12-10"])).success).toBe(false);
  });
});
