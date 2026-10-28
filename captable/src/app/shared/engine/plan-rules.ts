/**
 * Plan capacity: the five return-to-pool rules (the ledger and product rules).
 *
 * Each of these RETURNs shares to the plan's pool or RETIREs them: cancelled unvested awards, expired vested options,
 * repurchased unvested shares, repurchased vested shares, shares withheld for tax or net exercise.
 *
 * `DEFAULT_PLAN_RETURN_RULES` (all RETURN) is the one default in the system: it reproduces Pulley (available =
 * authorized − outstanding). SQL and the API hold none; the migration writes each plan's rules as `X_STOCK_PLAN_TERMS`
 * (R-13), and replay falls back to this default only for dates before a plan's first terms, with a warning.
 */

export type PlanReturnRule = "RETURN" | "RETIRE";

export interface PlanReturnRules {
  cancelledUnvestedAwards: PlanReturnRule;
  expiredVestedOptions: PlanReturnRule;
  repurchasedUnvestedShares: PlanReturnRule;
  repurchasedVestedShares: PlanReturnRule;
  sharesWithheldForTax: PlanReturnRule;
}

export const PLAN_RETURN_RULE_KEYS = [
  "cancelledUnvestedAwards",
  "expiredVestedOptions",
  "repurchasedUnvestedShares",
  "repurchasedVestedShares",
  "sharesWithheldForTax",
] as const satisfies readonly (keyof PlanReturnRules)[];

export const DEFAULT_PLAN_RETURN_RULES: Readonly<PlanReturnRules> = Object.freeze({
  cancelledUnvestedAwards: "RETURN",
  expiredVestedOptions: "RETURN",
  repurchasedUnvestedShares: "RETURN",
  repurchasedVestedShares: "RETURN",
  sharesWithheldForTax: "RETURN",
});

/** What happened to plan shares or awards, for choosing the rule. */
export type PoolEvent =
  | "CANCELLED_UNVESTED_AWARD"
  | "CANCELLED_VESTED_AWARD"
  | "REPURCHASED_UNVESTED_SHARES"
  | "REPURCHASED_VESTED_SHARES"
  | "SHARES_WITHHELD";

/**
 * The rule that applies to a pool event. A vested award cancelled for any reason (expiry, a waiver, mutual
 * agreement) follows "expired vested options": the five rules name expiry, and a waived vested option leaves the plan
 * the same way.
 */
export function ruleFor(event: PoolEvent, rules: PlanReturnRules): PlanReturnRule {
  switch (event) {
    case "CANCELLED_UNVESTED_AWARD":
      return rules.cancelledUnvestedAwards;
    case "CANCELLED_VESTED_AWARD":
      return rules.expiredVestedOptions;
    case "REPURCHASED_UNVESTED_SHARES":
      return rules.repurchasedUnvestedShares;
    case "REPURCHASED_VESTED_SHARES":
      return rules.repurchasedVestedShares;
    case "SHARES_WITHHELD":
      return rules.sharesWithheldForTax;
  }
}

/** The payload form (`X_STOCK_PLAN_TERMS.return_rules`, snake_case) in the engine's form. */
export function rulesFromPayload(rules: {
  cancelled_unvested_awards: PlanReturnRule;
  expired_vested_options: PlanReturnRule;
  repurchased_unvested_shares: PlanReturnRule;
  repurchased_vested_shares: PlanReturnRule;
  shares_withheld_for_tax: PlanReturnRule;
}): PlanReturnRules {
  return {
    cancelledUnvestedAwards: rules.cancelled_unvested_awards,
    expiredVestedOptions: rules.expired_vested_options,
    repurchasedUnvestedShares: rules.repurchased_unvested_shares,
    repurchasedVestedShares: rules.repurchased_vested_shares,
    sharesWithheldForTax: rules.shares_withheld_for_tax,
  };
}

/** The payload form of rules (what `set-plan-terms` writes; all five are required, there is no default). */
export function rulesToPayload(rules: PlanReturnRules): {
  cancelled_unvested_awards: PlanReturnRule;
  expired_vested_options: PlanReturnRule;
  repurchased_unvested_shares: PlanReturnRule;
  repurchased_vested_shares: PlanReturnRule;
  shares_withheld_for_tax: PlanReturnRule;
} {
  return {
    cancelled_unvested_awards: rules.cancelledUnvestedAwards,
    expired_vested_options: rules.expiredVestedOptions,
    repurchased_unvested_shares: rules.repurchasedUnvestedShares,
    repurchased_vested_shares: rules.repurchasedVestedShares,
    shares_withheld_for_tax: rules.sharesWithheldForTax,
  };
}
