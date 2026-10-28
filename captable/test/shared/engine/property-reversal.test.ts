import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { PLAN_RULES, WINDOWS } from "./fixtures/acme.ts";
import { LedgerBuilder, monthlyEvents, usd, uuid } from "./fixtures/builder.ts";

/**
 * Whole-command reversal on random valid ledgers that set and consume terms: plan terms (pool return
 * rules, default exercise and repurchase windows), Mark executed, terminations, extensions, expiries, accelerations,
 * leaves, restricted shares and their repurchase, exercises with withholding and ISO/NSO lots, share transfers with
 * balance lots, explicit returns to the pool, class splits, sometimes two in a row (they scale every lot and the
 * plans' aggregates), and corrections (wording, and plan terms' return rules, which change later pool outcomes).
 *
 * For every command the writer would allow to be reversed (no standing dependent by the edges it recorded):
 * - the engine's replay-without check finds nothing new;
 * - every later command means exactly what it meant: replaying without the reversed command, each later command
 *   changes the state in the same way (its counters, statuses, deadlines, pool outcome and violations);
 * - reversing it with X_REVERSALs is the same as never having recorded it.
 * So a command with a dependent is always refused, and a leaf's reversal restores the projections as if it never
 * happened. Capacity (authorized shares, plan pool) is out of scope by design: it never binds here.
 */

const FAR = "2099-12-31";
const PROPERTY_TIMEOUT = 300_000;

interface Step {
  kind: number;
  holder: number;
  a: number;
  b: number;
  gap: number;
  flag: boolean;
}

/**
 * Plan terms 5%, grant 14%, mark 4%, exercise 12%, waiver 5%, terminate 7%, extend 9%, expire 5%, accelerate 5%,
 * RSA 7%, repurchase 9%, leave 3%, transfer 5%, return to pool 3%, split 3%, correction 4%.
 */
const KIND_THRESHOLDS = [5, 19, 23, 35, 40, 47, 56, 61, 66, 73, 82, 85, 90, 93, 96, 100];

const arbStep: fc.Arbitrary<Step> = fc.record({
  kind: fc.integer({ min: 0, max: 99 }).map((roll) => KIND_THRESHOLDS.findIndex((limit) => roll < limit)),
  holder: fc.integer({ min: 0, max: 2 }),
  a: fc.nat({ max: 1_000_000 }),
  b: fc.nat({ max: 1_000_000 }),
  // Mostly days apart, so windows and deadlines are still open for the commands that use them; sometimes months.
  gap: fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 1, max: 20 }) }, { weight: 1, arbitrary: fc.integer({ min: 21, max: 150 }) }),
  flag: fc.boolean(),
});

interface World {
  b: LedgerBuilder;
  holders: string[];
  common: string;
  plan: string;
  grants: string[];
  rsas: string[];
  /** Share lots a transfer can move: exercise shares, restricted shares and earlier transfers' lots. */
  shares: string[];
  terminated: Set<string>;
  onLeave: Set<string>;
  /** Transactions already corrected (a transaction is corrected at most once). */
  corrected: Set<string>;
}

function bigint(value: e.Dec): bigint {
  return BigInt(value.toString());
}

function buildWorld(steps: Step[]): World {
  const b = new LedgerBuilder({ orgId: "00000000-0000-7000-8000-00000000d3b7" });
  const common = b.stockClass("r:CS", "COMMON", "Common");
  const plan = b.plan("r:P", common, "Plan");
  const holders = ["r:h0", "r:h1", "r:h2"].map((label) => b.stakeholder(label, "employee"));
  const w: World = { b, holders, common, plan, grants: [], rsas: [], shares: [], terminated: new Set(), onLeave: new Set(), corrected: new Set() };
  b.command("r:setup", (c) => {
    c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2020-01-01", { stock_class_id: common, new_shares_authorized: "1000000000" });
    c.tx("X_STOCK_PLAN_TERMS", "2020-01-01", { stock_plan_id: plan, return_rules: PLAN_RULES, default_termination_windows: WINDOWS, default_repurchase_window: { period: 90, period_type: "DAYS" }, status: "active", pour_over_plan_id: null });
    c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2020-01-01", { stock_plan_id: plan, shares_reserved: "100000000" });
  }, { type: "import", actorKind: "import", source: "import" });
  let date = "2020-01-01";
  steps.forEach((step, n) => {
    date = e.addDays(date, step.gap);
    const holder = holders[step.holder]!;
    const label = `r:${n}`;
    const state = () => b.replay(date);
    const pick = <T>(items: T[]): T | undefined => (items.length === 0 ? undefined : items[step.a % items.length]);
    switch (step.kind) {
      case 0: {
        // New plan terms: random return rules, default windows that may leave a termination type out.
        const rule = (bit: number) => ((step.b >> bit) & 1 ? "RETIRE" : "RETURN") as "RETURN" | "RETIRE";
        b.command(label, (c) => {
          c.tx("X_STOCK_PLAN_TERMS", date, {
            stock_plan_id: plan,
            return_rules: { cancelled_unvested_awards: rule(0), expired_vested_options: rule(1), repurchased_unvested_shares: rule(2), repurchased_vested_shares: rule(3), shares_withheld_for_tax: rule(4) },
            default_termination_windows: step.flag ? WINDOWS : [{ reason: "INVOLUNTARY_WITH_CAUSE", period: 0, period_type: "DAYS" }],
            default_repurchase_window: ([null, { period: 30, period_type: "DAYS" }, { period: 180, period_type: "DAYS" }] as const)[(step.b >> 5) % 3]!,
            status: "active",
            pour_over_plan_id: null,
          });
        }, { source: "app" });
        return;
      }
      case 1: {
        if (w.terminated.has(holder)) return;
        const quantity = BigInt(48 + (step.a % 20000));
        const shape = step.b % 3;
        // Vesting may start before the grant (a new hire's commencement date), so some of it is already vested.
        const start = e.addMonths(date, -((step.b >> 6) % 30));
        const events = shape === 0 ? null : monthlyEvents(quantity, start, shape === 1 ? 48 : 24, shape === 1 ? 12 : 0);
        const iso = step.flag;
        b.command(label, (c) => {
          const lot = c.security(`${label}:grant`, { family: "EQUITY_COMPENSATION", subtype: iso ? "OPTION_ISO" : "OPTION_NSO", stakeholderId: holder, stockClassId: common, stockPlanId: plan, parentSecurityId: null });
          const terms = events === null ? null : b.vestingTerms(`${label}:vt`, { type: "EXPLICIT", events: events.map((x) => ({ date: x.date, quantity: x.quantity })) });
          c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", date, {
            security_id: lot,
            custom_id: `OPT-${n}`,
            stakeholder_id: holder,
            stock_plan_id: plan,
            stock_class_id: common,
            compensation_type: iso ? "OPTION_ISO" : "OPTION_NSO",
            quantity: quantity.toString(),
            exercise_price: usd("1"),
            ...(terms ? { vesting_terms_id: terms.id, x_definition_sha256: terms.sha } : {}),
            expiration_date: e.addYears(date, 10),
            termination_exercise_windows: (step.b >> 3) & 1 ? WINDOWS : [], // [] = the plan's defaults
            x_fmv: { price_per_share: usd("1"), valuation_id: null, source: "IMPORTED" },
          });
          if (events !== null) c.tx("TX_VESTING_START", date, { security_id: lot, x_vesting_start_date: start });
          if ((step.b >> 4) & 1) c.tx("X_EXECUTION_STATUS", date, { security_id: lot, status: "pending_company" });
          w.grants.push(lot);
        }, { source: "app" });
        return;
      }
      case 2: {
        const s = state();
        const lot = pick(w.grants.filter((id) => s.securities.get(id)!.executionStatus.startsWith("pending") && s.securities.get(id)!.closedBy === null));
        if (!lot) return;
        b.command(label, (c) => c.tx("X_EXECUTION_STATUS", date, { security_id: lot, status: "executed" }), { source: "app" });
        return;
      }
      case 3: {
        const s = state();
        const lot = pick(w.grants.filter((id) => e.exercisability(s, s.securities.get(id)!, date).exercisable.isPositive()));
        if (!lot) return;
        const security = s.securities.get(lot)!;
        const exercisable = bigint(e.exercisability(s, security, date).exercisable);
        const quantity = 1n + BigInt(step.b) % exercisable;
        const withheld = step.flag && quantity >= 4n ? quantity / 4n : 0n;
        const iso = security.identity.subtype === "OPTION_ISO";
        let isoLots = 0n;
        if (iso) {
          isoLots = bigint(e.isoLotsAvailable(s, security, date).iso);
          if (isoLots > quantity) isoLots = quantity;
        }
        const isoDeadline = iso ? e.isoDeadline(s, security)?.date ?? null : null;
        const late = isoDeadline !== null && date > isoDeadline;
        // Withheld shares come from the ISO lots first; ISO lots after the ISO deadline are NSO shares, with that reason.
        const isoShares = late ? 0n : isoLots > withheld ? isoLots - withheld : 0n;
        const nsoShares = quantity - withheld - isoShares;
        const nsoReason = late && isoLots > 0n ? "AFTER_ISO_DEADLINE" : iso ? "ISO_LIMIT" : undefined;
        b.command(label, (c) => {
          const lots = ([["ISO", isoShares], ["NSO", nsoShares]] as const)
            .filter(([, q]) => q > 0n)
            .map(([portion, q]) => ({ portion, q, id: c.security(`${label}:${portion}`, { family: "STOCK", subtype: "COMMON", stakeholderId: holderOf(s, lot), stockClassId: common, stockPlanId: plan, parentSecurityId: lot }) }));
          c.tx("TX_EQUITY_COMPENSATION_EXERCISE", date, {
            security_id: lot,
            quantity: quantity.toString(),
            resulting_security_ids: lots.map((x) => x.id),
            x_portions: lots.map((x) => ({ portion: x.portion, quantity: x.q.toString(), security_id: x.id, ...(x.portion === "NSO" && nsoReason ? { reason: nsoReason } : {}) })),
            x_lots_consumed: { iso: isoLots.toString(), nso: (quantity - isoLots).toString() },
            ...(withheld > 0n ? { x_withheld_quantity: withheld.toString() } : {}),
          });
          for (const x of lots) {
            c.tx("TX_STOCK_ISSUANCE", date, { security_id: x.id, custom_id: `CS-${n}-${x.portion}`, stakeholder_id: holderOf(s, lot), stock_class_id: common, stock_plan_id: plan, share_price: usd("1"), quantity: x.q.toString(), x_origin: "EXERCISE", x_source_security_id: lot, x_portion: x.portion });
            w.shares.push(x.id);
          }
        }, { source: "app" });
        return;
      }
      case 4: {
        const s = state();
        const lot = pick(w.grants.filter((id) => s.securities.get(id)!.closedBy === null && s.securities.get(id)!.outstanding.isPositive()));
        if (!lot) return;
        const outstanding = bigint(s.securities.get(lot)!.outstanding);
        const quantity = 1n + BigInt(step.b) % outstanding;
        b.command(label, (c) => c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", date, { security_id: lot, quantity: quantity.toString(), reason_text: "Holder waiver", x_reason: "HOLDER_WAIVER" }), { source: "app" });
        return;
      }
      case 5: {
        if (w.terminated.has(holder)) return;
        const s = state();
        const type = (["voluntary", "involuntary", "with_cause"] as const)[step.b % 3]!;
        b.command(label, (c) => {
          c.tx("X_STAKEHOLDER_TERMINATION", date, { stakeholder_id: holder, termination_date: date, termination_type: type, vesting_stop_date: date, relationship_before: "employee", relationship_after: "ex_employee" });
          for (const lot of w.grants) {
            const security = s.securities.get(lot)!;
            if (security.identity.stakeholderId !== holder || security.closedBy !== null) continue;
            const unvested = e.positionAt(s, security, date).unvestedOutstanding;
            if (unvested.isPositive()) c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", date, { security_id: lot, quantity: unvested.toString(), reason_text: "Termination", x_reason: "TERMINATION" });
          }
        }, { source: "app", type: "terminate-stakeholder" });
        w.terminated.add(holder);
        return;
      }
      case 6: {
        const s = state();
        const lot = pick(
          w.grants.filter((id) => {
            const security = s.securities.get(id)!;
            const deadline = e.contractualDeadline(security)?.date ?? null;
            return security.closedBy === null && security.outstanding.isPositive() && deadline !== null && date <= deadline && security.expirationDate !== null && deadline < security.expirationDate;
          }),
        );
        if (!lot) return;
        const security = s.securities.get(lot)!;
        const extended = e.minDate(e.addDays(e.contractualDeadline(security)!.date, 30 + (step.b % 300)), security.expirationDate!);
        b.command(label, (c) => c.tx("X_SECURITY_MODIFICATION", date, { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: lot, new_contractual_deadline: extended }), { source: "app" });
        return;
      }
      case 7: {
        const s = state();
        const lot = pick(
          w.grants.filter((id) => {
            const security = s.securities.get(id)!;
            const last = e.lastExerciseDate(security);
            return security.closedBy === null && security.outstanding.isPositive() && last !== null && date > last;
          }),
        );
        if (!lot) return;
        const outstanding = s.securities.get(lot)!.outstanding.toString();
        b.command(label, (c) => c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", date, { security_id: lot, quantity: outstanding, reason_text: "Expired", x_reason: "EXPIRED" }), { source: "system", type: "expire-options" });
        return;
      }
      case 8: {
        const s = state();
        const room = (id: string) => {
          const security = s.securities.get(id)!;
          if (security.closedBy !== null || !e.hasVestingSchedule(security)) return 0n;
          const gross = e.vestedAt(e.vestingInputsFor(s, security), date);
          const left = security.issuedQuantity.sub(security.cancelledUnvested).sub(security.repurchasedUnvested).sub(gross);
          return left.isPositive() ? bigint(left) : 0n;
        };
        const lot = pick(w.grants.filter((id) => room(id) > 0n));
        if (!lot) return;
        const quantity = 1n + BigInt(step.b) % room(lot);
        b.command(label, (c) => c.tx("TX_VESTING_ACCELERATION", date, { security_id: lot, quantity: quantity.toString(), reason_text: "Board approval" }), { source: "app" });
        return;
      }
      case 9: {
        if (w.terminated.has(holder)) return;
        const quantity = BigInt(48 + (step.a % 10000));
        b.command(label, (c) => {
          const lot = c.security(`${label}:rsa`, { family: "STOCK", subtype: "COMMON", stakeholderId: holder, stockClassId: common, stockPlanId: plan, parentSecurityId: null });
          const start = e.addMonths(date, -((step.b >> 6) % 30));
          const terms = b.vestingTerms(`${label}:vt`, { type: "EXPLICIT", events: monthlyEvents(quantity, start, 48, 12).map((x) => ({ date: x.date, quantity: x.quantity })) });
          c.tx("TX_STOCK_ISSUANCE", date, {
            security_id: lot,
            custom_id: `RSA-${n}`,
            stakeholder_id: holder,
            stock_class_id: common,
            stock_plan_id: plan,
            share_price: usd("0.1"),
            quantity: quantity.toString(),
            x_origin: "RSA",
            vesting_terms_id: terms.id,
            x_definition_sha256: terms.sha,
            ...(step.flag && step.b % 3 === 0 ? { x_repurchase_right: { price_per_share: usd("0.1"), window: { period: 60, period_type: "DAYS" } } } : {}),
          });
          w.rsas.push(lot);
          w.shares.push(lot);
        }, { source: "app" });
        return;
      }
      case 10: {
        const s = state();
        const lot = pick(
          w.rsas.filter((id) => {
            const security = s.securities.get(id)!;
            const deadline = e.repurchaseDeadline(s, security);
            return security.termination !== null && security.closedBy === null && e.positionAt(s, security, date).unvestedOutstanding.isPositive() && (deadline === null || date <= deadline);
          }),
        );
        if (!lot) return;
        const unvested = bigint(e.positionAt(s, s.securities.get(lot)!, date).unvestedOutstanding);
        const quantity = 1n + BigInt(step.b) % unvested;
        b.command(label, (c) => c.tx("TX_STOCK_REPURCHASE", date, { security_id: lot, quantity: quantity.toString(), price: usd("0.1"), x_kind: "UNVESTED" }), { source: "app" });
        return;
      }
      case 11: {
        if (w.terminated.has(holder) || w.onLeave.has(holder)) return;
        b.command(label, (c) => c.tx("X_STAKEHOLDER_LEAVE", date, { stakeholder_id: holder, start_date: date, end_date: null, return_guaranteed: step.flag }), { source: "app" });
        w.onLeave.add(holder);
        return;
      }
      case 12: {
        // Some of a share lot to another holder; the rest goes to a balance lot.
        const s = state();
        const source = pick(w.shares.filter((id) => s.securities.get(id)!.closedBy === null && s.securities.get(id)!.outstanding.isPositive()));
        if (!source) return;
        const from = s.securities.get(source)!;
        const outstanding = bigint(from.outstanding);
        const quantity = 1n + BigInt(step.b) % outstanding;
        const to = holders[(holders.indexOf(from.identity.stakeholderId) + 1 + (step.holder % 2)) % holders.length]!;
        b.command(label, (c) => {
          const lot = c.security(`${label}:to`, { family: "STOCK", subtype: "COMMON", stakeholderId: to, stockClassId: common, stockPlanId: plan, parentSecurityId: source });
          c.tx("TX_STOCK_ISSUANCE", date, { security_id: lot, custom_id: `CS-${n}-T`, stakeholder_id: to, stock_class_id: common, stock_plan_id: plan, share_price: usd("1"), quantity: quantity.toString(), x_origin: "TRANSFER", x_source_security_id: source });
          w.shares.push(lot);
          let balance: string | undefined;
          if (quantity < outstanding) {
            balance = c.security(`${label}:rest`, { family: "STOCK", subtype: "COMMON", stakeholderId: from.identity.stakeholderId, stockClassId: common, stockPlanId: plan, parentSecurityId: source });
            c.tx("TX_STOCK_ISSUANCE", date, { security_id: balance, custom_id: `CS-${n}-B`, stakeholder_id: from.identity.stakeholderId, stock_class_id: common, stock_plan_id: plan, share_price: usd("1"), quantity: (outstanding - quantity).toString(), x_origin: "BALANCE", x_source_security_id: source });
            w.shares.push(balance);
          }
          c.tx("TX_STOCK_TRANSFER", date, { security_id: source, quantity: quantity.toString(), resulting_security_ids: [lot], ...(balance ? { balance_security_id: balance } : {}), x_reason: "SECONDARY_SALE" });
        }, { source: "app" });
        return;
      }
      case 13: {
        // Return retired shares to the pool explicitly (never more than are retired).
        const s = state();
        const p = s.plans.get(plan)!;
        const room = bigint(p.retired.sub(p.explicitReturns));
        if (room <= 0n) return;
        const quantity = 1n + BigInt(step.b) % room;
        b.command(label, (c) => c.tx("TX_STOCK_PLAN_RETURN_TO_POOL", date, { stock_plan_id: plan, quantity: quantity.toString(), reason_text: "Board resolution" }), { source: "app" });
        return;
      }
      case 14: {
        // A 2:1 or 3:2 forward split of the common class: lots, awards, prices and the plans' aggregates scale. Half
        // the time a second split follows at once, as its own command.
        const [numerator, denominator] = step.flag ? ["2", "1"] : ["3", "2"];
        b.command(label, (c) => c.tx("TX_STOCK_CLASS_SPLIT", date, { stock_class_id: common, split_ratio: { numerator, denominator } }), { source: "app" });
        if (step.b % 2 === 0) b.command(`${label}:again`, (c) => c.tx("TX_STOCK_CLASS_SPLIT", date, { stock_class_id: common, split_ratio: { numerator: "2", denominator: "1" } }), { source: "app" });
        return;
      }
      case 15: {
        // A correction of an earlier app transaction: new wording, or plan terms with other return rules.
        const target = pick(
          b.transactions.filter(
            (t) =>
              t.source === "app" &&
              !w.corrected.has(t.id) &&
              (t.type === "X_STOCK_PLAN_TERMS" || t.type === "TX_EQUITY_COMPENSATION_ISSUANCE" || t.type === "TX_EQUITY_COMPENSATION_EXERCISE" || (t.type === "TX_EQUITY_COMPENSATION_CANCELLATION" && t.payload.x_reason === "HOLDER_WAIVER")),
          ),
        );
        if (!target) return;
        const rule = (bit: number) => ((step.b >> bit) & 1 ? "RETIRE" : "RETURN") as "RETURN" | "RETIRE";
        const replacement =
          target.type === "X_STOCK_PLAN_TERMS"
            ? { ...target.payload, return_rules: { cancelled_unvested_awards: rule(0), expired_vested_options: rule(1), repurchased_unvested_shares: rule(2), repurchased_vested_shares: rule(3), shares_withheld_for_tax: rule(4) } }
            : target.type === "TX_EQUITY_COMPENSATION_CANCELLATION"
              ? { ...target.payload, reason_text: `Waiver, corrected ${n}` }
              : { ...target.payload, comments: [`Corrected ${n}`] };
        b.command(label, (c) => c.tx("X_CORRECTION", date, { supersedes_tx_id: target.id, replacement_payload: replacement, reason: "Clerical" }), { source: "app" });
        w.corrected.add(target.id);
        return;
      }
    }
  });
  return w;
}

function holderOf(state: e.LedgerState, lot: string): string {
  return state.securities.get(lot)!.identity.stakeholderId;
}

const COUNTERS = [
  "issuedQuantity",
  "outstanding",
  "exercised",
  "released",
  "cancelled",
  "cancelledUnvested",
  "cancelledVested",
  "expired",
  "repurchased",
  "repurchasedUnvested",
  "repurchasedVested",
  "forfeited",
  "transferred",
  "converted",
  "reissued",
  "movedToBalance",
] as const;

/**
 * The raw replayed facts a command can change: counters (compared as differences), statuses, deadlines and records
 * (compared as values or items added). Vested-at-a-date figures are left out: a cap makes them non-additive, and
 * every command that reads vesting is covered by its counters and violations.
 */
function facts(state: e.LedgerState): Map<string, { number: e.Dec } | { value: string } | { items: string[] }> {
  const out = new Map<string, { number: e.Dec } | { value: string } | { items: string[] }>();
  for (const s of state.securities.values()) {
    if (!s.issued) continue;
    const id = s.identity.id;
    for (const key of COUNTERS) out.set(`${id}.${key}`, { number: s[key] });
    out.set(`${id}.status`, { value: `${s.status}:${s.closedBy?.transactionId ?? ""}` });
    out.set(`${id}.vestingStop`, { value: s.vestingStop?.date ?? "" });
    out.set(`${id}.computedDeadline`, { value: s.computedDeadline?.deadline ?? "" });
    out.set(`${id}.extendedDeadline`, { value: s.extendedDeadline?.deadline ?? "" });
    out.set(`${id}.executionStatus`, { value: s.executionStatus });
    out.set(`${id}.accelerations`, { items: s.accelerations.map((x) => `${x.transactionId}:${x.date}:${x.quantity}`) });
    out.set(`${id}.exercises`, { items: s.exercises.map((x) => `${x.transactionId}:${x.quantity}:${x.lotsConsumed.iso}:${x.lotsConsumed.nso}:${x.withheld}:${x.portions.map((p) => `${p.portion}${p.quantity}`).join("+")}`) });
  }
  for (const plan of state.plans.values()) {
    const id = plan.ref.id;
    for (const key of ["poolSize", "retired", "returned", "explicitReturns", "grantedGross"] as const) out.set(`${id}.${key}`, { number: plan[key] });
    out.set(`${id}.terms`, { items: plan.termsHistory.map((t) => t.transactionId) });
  }
  for (const stakeholder of state.stakeholders.values()) {
    out.set(`${stakeholder.ref.id}.terminations`, { items: stakeholder.terminations.map((t) => t.transactionId) });
    out.set(`${stakeholder.ref.id}.leaves`, { items: stakeholder.leaves.map((t) => t.transactionId) });
  }
  out.set("violations", { items: state.violations.map(e.violationKey) });
  return out;
}

/** What applying a command did: the facts it changed, as differences, new values or items added and removed. */
function effect(before: e.LedgerState, after: e.LedgerState): Record<string, string> {
  const a = facts(before);
  const b = facts(after);
  const changes: Record<string, string> = {};
  for (const [key, next] of b) {
    const prior = a.get(key);
    if ("number" in next) {
      const delta = next.number.sub(prior && "number" in prior ? prior.number : e.Dec.ZERO);
      if (!delta.isZero()) changes[key] = delta.toString();
    } else if ("value" in next) {
      const old = prior && "value" in prior ? prior.value : null;
      if (old !== next.value) changes[key] = next.value;
    } else {
      const old = new Set(prior && "items" in prior ? prior.items : []);
      const added = next.items.filter((item) => !old.has(item));
      const removed = [...old].filter((item) => !next.items.includes(item));
      if (added.length > 0 || removed.length > 0) changes[key] = `+${added.join(",")} -${removed.join(",")}`;
    }
  }
  return changes;
}

/**
 * The property for one generated ledger. Returns false when the ledger couldn't have been written (a plan terms
 * correction made an earlier explicit return exceed what is now retired), so the property can skip it.
 */
function checkReversals(steps: Step[]): boolean {
  const w = buildWorld(steps);
  const { reference, transactions } = w.b;
  const all = reference.commands;
  const errors = e.replay(reference, transactions, { asOf: FAR }).violations.filter((v) => v.severity === "error");
  if (w.corrected.size > 0 && errors.length > 0) return false;
  expect(errors).toEqual([]);
  // Edges as the writer records them: from the dry run of the ledger through each command.
  const edges = all.flatMap((command) => e.commandDependencies(e.replay(reference, transactions.filter((t) => t.seq <= command.lastSeq), { asOf: FAR }), command.id));
  for (const edge of edges) expect(all.find((c) => c.id === edge.dependsOnCommandId)!.firstSeq).toBeLessThan(all.find((c) => c.id === edge.commandId)!.firstSeq);
  const knownAt = (txs: readonly e.LedgerTransaction[], seq: number) => e.replay(reference, txs, { asOf: FAR, asKnownAt: seq });
  const effects = (txs: readonly e.LedgerTransaction[]) => new Map(all.map((command) => [command.id, effect(knownAt(txs, command.firstSeq - 1), knownAt(txs, command.lastSeq))]));
  const withAll = effects(transactions);
  let leaves = 0;
  for (const target of all) {
    if (e.reversalRefusal(target.id, edges, all) !== null) continue;
    leaves += 1;
    const without = transactions.filter((t) => t.commandId !== target.id);
    expect(e.reversalViolations(reference, transactions, target.id, { asOf: FAR }), `reversing ${target.type} ${target.id}`).toEqual([]);
    const withoutTarget = effects(without);
    for (const later of all) {
      if (later.firstSeq <= target.firstSeq) continue;
      expect(withoutTarget.get(later.id), `${later.type} ${later.id} after reversing ${target.type} ${target.id}`).toEqual(withAll.get(later.id));
    }
    // Reversing with X_REVERSALs is the same as never having recorded the command.
    const seq0 = transactions[transactions.length - 1]!.seq;
    const reversals = transactions
      .filter((t) => t.commandId === target.id)
      .reverse()
      .map((t, i) =>
        e.decodeTransaction({ id: uuid(`rev:${t.id}`), seq: seq0 + 1 + i, commandId: uuid(`rev:${target.id}`), type: "X_REVERSAL", effectiveDate: FAR, payload: { reverses_tx_id: t.id }, reversesTxId: t.id, source: "app" }),
      );
    expect(e.stateSummary(e.replay(reference, [...transactions, ...reversals], { asOf: FAR }))).toEqual({
      ...e.stateSummary(e.replay(reference, without, { asOf: FAR })),
      ledgerSeq: seq0 + reversals.length,
    });
  }
  if (all.some((c) => c.actorKind !== "import")) expect(leaves).toBeGreaterThan(0); // the newest command at least
  return true;
}

describe("whole-command reversal", () => {
  it("refuses every command another one depends on, and a leaf's reversal leaves every later command meaning the same", () => {
    fc.assert(
      fc.property(fc.array(arbStep, { minLength: 1, maxLength: 40, size: "max" }), (steps) => {
        fc.pre(checkReversals(steps));
      }),
      { numRuns: 60 },
    );
  }, PROPERTY_TIMEOUT);

  // Cases the property found, kept so they run every time.
  const step = (kind: number, b = 0, gap = 1, flag = false, a = 0): Step => ({ kind, holder: 0, a, b, gap, flag });
  it("keeps an explicit return relying on a split that scaled the shares it returns", () => {
    // One 2:1 split (an odd b), so the second return needs the shares only the split retired.
    expect(checkReversals([step(1), step(0, 2), step(4), step(14, 1, 1, true), step(13, 0, 21), step(13, 0, 21)])).toBe(true);
  });

  it("keeps an explicit return relying on the correction of the plan terms that made shares retire", () => {
    expect(checkReversals([step(1), step(0, 0, 21), step(4), step(15, 2, 1, false, 813511), step(13), step(0)])).toBe(true);
  });

  it("keeps a correction relying on the earlier exercise it re-interprets", () => {
    expect(
      checkReversals([step(0, 0, 21), step(0, 0, 21), step(0), step(1), step(0, 0, 21), step(0), step(0), step(3, 3, 1, true), step(15, 269680, 1, false, 171950), step(0, 0, 21)]),
    ).toBe(true);
  });
});
