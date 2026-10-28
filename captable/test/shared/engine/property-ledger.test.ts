import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { LedgerBuilder, monthlyEvents, usd } from "./fixtures/builder.ts";

/**
 * Model-based property tests: random command sequences are interpreted against a naive model that
 * recomputes positions from scratch, and the engine's replay must agree with it, never go negative, keep the cap
 * table identities, and treat a reversal exactly like a command that never happened.
 */

interface Step {
  kind: number;
  holder: number;
  a: number;
  b: number;
  gap: number;
  flag: boolean;
}

/** Command kinds, weighted so ledgers grow: issue 15%, grant 30%, exercise 25%, cancel 10%, terminate 5%, transfer 15%. */
const KIND_THRESHOLDS = [15, 45, 70, 80, 85, 100];

const arbStep: fc.Arbitrary<Step> = fc.record({
  kind: fc.integer({ min: 0, max: 99 }).map((roll) => KIND_THRESHOLDS.findIndex((limit) => roll < limit)),
  holder: fc.integer({ min: 0, max: 3 }),
  a: fc.nat({ max: 1_000_000 }),
  b: fc.nat({ max: 1_000_000 }),
  gap: fc.integer({ min: 1, max: 75 }),
  flag: fc.boolean(),
});

const arbRules = fc.record({
  cancelled_unvested_awards: fc.constantFrom("RETURN" as const, "RETIRE" as const),
  expired_vested_options: fc.constantFrom("RETURN" as const, "RETIRE" as const),
  repurchased_unvested_shares: fc.constantFrom("RETURN" as const, "RETIRE" as const),
  repurchased_vested_shares: fc.constantFrom("RETURN" as const, "RETIRE" as const),
  shares_withheld_for_tax: fc.constantFrom("RETURN" as const, "RETIRE" as const),
});

interface ModelGrant {
  id: string;
  holder: string;
  issued: bigint;
  outstanding: bigint;
  exercised: bigint;
  cancelledUnvested: bigint;
  cancelledVested: bigint;
  events: { date: string; quantity: bigint }[] | null;
  grantDate: string;
  stop: string | null;
  early: boolean;
  deadline: string | null;
  iso: boolean;
}

interface ModelLot {
  id: string;
  holder: string;
  outstanding: bigint;
  plan: boolean;
}

interface World {
  b: LedgerBuilder;
  holders: string[];
  common: string;
  plan: string;
  pool: bigint;
  rules: e.PayloadOf<"X_STOCK_PLAN_TERMS">["return_rules"];
  retired: bigint;
  grants: ModelGrant[];
  lots: ModelLot[];
  terminated: Set<string>;
  dates: string[];
  commandLabels: string[];
}

const WINDOWS: e.TerminationWindow[] = [{ reason: "VOLUNTARY_OTHER", period: 3, period_type: "MONTHS" }];

/** Model-based runs replay every prefix and every date: allow them time on a slow CI machine. */
const PROPERTY_TIMEOUT = 180_000;

function vestedGross(g: ModelGrant, date: string): bigint {
  if (g.events === null) return g.issued;
  const limit = g.stop !== null && g.stop < date ? g.stop : date;
  let vested = 0n;
  for (const event of g.events) if (event.date <= limit) vested += event.quantity;
  return vested;
}

function vestedOutstanding(g: ModelGrant, date: string): bigint {
  const gross = vestedGross(g, date);
  const cap = g.issued - g.cancelledUnvested;
  const vested = gross < cap ? gross : cap;
  let free = vested - g.exercised - g.cancelledVested;
  if (free < 0n) free = 0n;
  return free < g.outstanding ? free : g.outstanding;
}

function frac(total: bigint, b: number): bigint {
  return (total * BigInt((b % 100) + 1)) / 100n;
}

function planUsed(w: World): bigint {
  const awards = w.grants.reduce((s, g) => s + g.outstanding, 0n);
  const shares = w.lots.filter((l) => l.plan).reduce((s, l) => s + l.outstanding, 0n);
  return awards + shares + w.retired;
}

function cancelSplit(w: World, g: ModelGrant, quantity: bigint, date: string): void {
  const free = vestedOutstanding(g, date);
  const unvestedOutstanding = g.outstanding - free;
  const unvested = quantity < unvestedOutstanding ? quantity : unvestedOutstanding;
  const vested = quantity - unvested;
  g.cancelledUnvested += unvested;
  g.cancelledVested += vested;
  g.outstanding -= quantity;
  if (w.rules.cancelled_unvested_awards === "RETIRE") w.retired += unvested;
  if (w.rules.expired_vested_options === "RETIRE") w.retired += vested;
}

function buildWorld(steps: Step[], rules: World["rules"]): World {
  const b = new LedgerBuilder({ orgId: "00000000-0000-7000-8000-0000000f0f0f" });
  const common = b.stockClass("p:CS", "COMMON", "Common");
  const plan = b.plan("p:P", common, "Plan");
  const holders = ["p:h0", "p:h1", "p:h2", "p:h3"].map((label) => b.stakeholder(label, "employee"));
  const w: World = { b, holders, common, plan, pool: 2000000n, rules, retired: 0n, grants: [], lots: [], terminated: new Set(), dates: [], commandLabels: [] };
  b.command("p:setup", (c) => {
    c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2020-01-01", { stock_class_id: common, new_shares_authorized: "1000000000" });
    c.tx("X_STOCK_PLAN_TERMS", "2020-01-01", {
      stock_plan_id: plan,
      return_rules: rules,
      default_termination_windows: WINDOWS,
      default_repurchase_window: null,
      status: "active",
      pour_over_plan_id: null,
    });
    c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2020-01-01", { stock_plan_id: plan, shares_reserved: "2000000" });
  });
  let date = "2020-01-01";
  steps.forEach((step, n) => {
    date = e.addDays(date, step.gap);
    const holder = holders[step.holder]!;
    const label = `p:${n}`;
    const record = () => {
      w.dates.push(date);
      w.commandLabels.push(label);
    };
    switch (step.kind) {
      case 0: {
        const quantity = BigInt(1 + (step.a % 100000));
        b.command(label, (c) => {
          const lot = c.security(`${label}:lot`, { family: "STOCK", subtype: "COMMON", stakeholderId: holder, stockClassId: common, stockPlanId: null, parentSecurityId: null });
          c.tx("TX_STOCK_ISSUANCE", date, { security_id: lot, custom_id: `CS-${n}`, stakeholder_id: holder, stock_class_id: common, share_price: usd("1"), quantity: quantity.toString(), x_origin: "PURCHASE" });
          w.lots.push({ id: lot, holder, outstanding: quantity, plan: false });
        });
        record();
        return;
      }
      case 1: {
        const quantity = BigInt(1 + (step.a % 50000));
        if (w.terminated.has(holder) || w.pool - planUsed(w) < quantity) return;
        const shape = step.b % 3;
        const start = shape === 2 ? e.addMonths(date, -(step.b % 12)) : date;
        const events = shape === 0 ? null : shape === 1 ? monthlyEvents(quantity, start, 48, 12) : monthlyEvents(quantity, start, 24, 0);
        const early = step.b % 7 === 0;
        b.command(label, (c) => {
          const lot = c.security(`${label}:grant`, {
            family: "EQUITY_COMPENSATION",
            subtype: step.flag ? "OPTION_ISO" : "OPTION_NSO",
            stakeholderId: holder,
            stockClassId: common,
            stockPlanId: plan,
            parentSecurityId: null,
          });
          const terms = events === null ? null : b.vestingTerms(`${label}:vt`, { type: "EXPLICIT", events: events.map((x) => ({ date: x.date, quantity: x.quantity })) });
          c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", date, {
            security_id: lot,
            custom_id: `OPT-${n}`,
            stakeholder_id: holder,
            stock_plan_id: plan,
            stock_class_id: common,
            compensation_type: step.flag ? "OPTION_ISO" : "OPTION_NSO",
            quantity: quantity.toString(),
            exercise_price: usd("1"),
            early_exercisable: early,
            ...(terms ? { vesting_terms_id: terms.id, x_definition_sha256: terms.sha } : {}),
            expiration_date: e.addYears(date, 10),
            termination_exercise_windows: WINDOWS,
            x_fmv: { price_per_share: usd("1"), valuation_id: null, source: "IMPORTED" },
          });
          if (events !== null) c.tx("TX_VESTING_START", date, { security_id: lot, x_vesting_start_date: start });
          w.grants.push({
            id: lot,
            holder,
            issued: quantity,
            outstanding: quantity,
            exercised: 0n,
            cancelledUnvested: 0n,
            cancelledVested: 0n,
            events: events?.map((x) => ({ date: x.date, quantity: BigInt(x.quantity) })) ?? null,
            grantDate: date,
            stop: null,
            early,
            deadline: null,
            iso: step.flag,
          });
        }, { source: "app" });
        record();
        return;
      }
      case 2: {
        const open = w.grants.filter((g) => g.outstanding > 0n && (g.deadline === null || date <= g.deadline));
        if (open.length === 0) return;
        const g = open[step.a % open.length]!;
        const available = g.early ? g.outstanding : vestedOutstanding(g, date);
        const quantity = frac(available, step.b);
        if (quantity === 0n) return;
        // ISO lots first, as the writer frees them: the engine's view of the ledger so far gives the ISO
        // lots still available; the rest are NSO lots over the $100K limit. Each portion is its own lot.
        let isoLots = 0n;
        if (g.iso) {
          const state = w.b.replay(date);
          isoLots = BigInt(e.isoLotsAvailable(state, state.securities.get(g.id)!, date).iso.toString());
          if (isoLots > quantity) isoLots = quantity;
        }
        const portions = ([["ISO", isoLots], ["NSO", quantity - isoLots]] as const).filter(([, q]) => q > 0n);
        const lots: { id: string; portion: "ISO" | "NSO"; quantity: bigint }[] = [];
        b.command(label, (c) => {
          for (const [portion, q] of portions) {
            lots.push({ id: c.security(`${label}:${portion}`, { family: "STOCK", subtype: "COMMON", stakeholderId: g.holder, stockClassId: common, stockPlanId: plan, parentSecurityId: g.id }), portion, quantity: q });
          }
          c.tx("TX_EQUITY_COMPENSATION_EXERCISE", date, {
            security_id: g.id,
            quantity: quantity.toString(),
            resulting_security_ids: lots.map((lot) => lot.id),
            x_portions: lots.map((lot) => ({ portion: lot.portion, quantity: lot.quantity.toString(), security_id: lot.id, ...(lot.portion === "NSO" && g.iso ? { reason: "ISO_LIMIT" as const } : {}) })),
            x_lots_consumed: { iso: isoLots.toString(), nso: (quantity - isoLots).toString() },
          });
          for (const lot of lots) {
            c.tx("TX_STOCK_ISSUANCE", date, {
              security_id: lot.id,
              custom_id: `CS-${n}-${lot.portion}`,
              stakeholder_id: g.holder,
              stock_class_id: common,
              stock_plan_id: plan,
              share_price: usd("1"),
              quantity: lot.quantity.toString(),
              x_origin: "EXERCISE",
              x_source_security_id: g.id,
              x_portion: lot.portion,
            });
          }
        }, { source: "app" });
        g.outstanding -= quantity;
        g.exercised += quantity;
        for (const lot of lots) w.lots.push({ id: lot.id, holder: g.holder, outstanding: lot.quantity, plan: true });
        record();
        return;
      }
      case 3: {
        const open = w.grants.filter((g) => g.outstanding > 0n);
        if (open.length === 0) return;
        const g = open[step.a % open.length]!;
        const quantity = frac(g.outstanding, step.b);
        if (quantity === 0n) return;
        b.command(label, (c) => {
          c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", date, { security_id: g.id, quantity: quantity.toString(), reason_text: "Holder waiver", x_reason: "HOLDER_WAIVER" });
        }, { source: "app" });
        cancelSplit(w, g, quantity, date);
        record();
        return;
      }
      case 4: {
        if (w.terminated.has(holder)) return;
        const affected = w.grants.filter((g) => g.holder === holder && g.grantDate <= date);
        b.command(label, (c) => {
          c.tx("X_STAKEHOLDER_TERMINATION", date, {
            stakeholder_id: holder,
            termination_date: date,
            termination_type: "voluntary",
            vesting_stop_date: date,
            relationship_before: "employee",
            relationship_after: "ex_employee",
          });
          for (const g of affected) {
            g.stop = date;
            if (g.outstanding > 0n) g.deadline = e.addMonths(date, 3) < e.addYears(g.grantDate, 10) ? e.addMonths(date, 3) : e.addYears(g.grantDate, 10);
            const unvested = g.outstanding - vestedOutstanding(g, date);
            if (unvested > 0n) {
              c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", date, { security_id: g.id, quantity: unvested.toString(), reason_text: "Termination", x_reason: "TERMINATION" });
              cancelSplit(w, g, unvested, date);
            }
          }
        }, { source: "app", type: "terminate-stakeholder" });
        w.terminated.add(holder);
        record();
        return;
      }
      case 5: {
        const open = w.lots.filter((l) => l.outstanding > 0n);
        if (open.length === 0) return;
        const lot = open[step.a % open.length]!;
        const quantity = frac(lot.outstanding, step.b);
        if (quantity === 0n) return;
        const to = holders[(holders.indexOf(lot.holder) + 1 + (step.holder % 3)) % 4]!;
        const rest = lot.outstanding - quantity;
        b.command(label, (c) => {
          const recipient = c.security(`${label}:to`, { family: "STOCK", subtype: "COMMON", stakeholderId: to, stockClassId: common, stockPlanId: lot.plan ? plan : null, parentSecurityId: lot.id });
          c.tx("TX_STOCK_ISSUANCE", date, {
            security_id: recipient,
            custom_id: `CS-${n}-T`,
            stakeholder_id: to,
            stock_class_id: common,
            ...(lot.plan ? { stock_plan_id: plan } : {}),
            share_price: usd("1"),
            quantity: quantity.toString(),
            x_origin: "TRANSFER",
            x_source_security_id: lot.id,
          });
          let balance: string | undefined;
          if (rest > 0n) {
            balance = c.security(`${label}:balance`, { family: "STOCK", subtype: "COMMON", stakeholderId: lot.holder, stockClassId: common, stockPlanId: lot.plan ? plan : null, parentSecurityId: lot.id });
            c.tx("TX_STOCK_ISSUANCE", date, {
              security_id: balance,
              custom_id: `CS-${n}-B`,
              stakeholder_id: lot.holder,
              stock_class_id: common,
              ...(lot.plan ? { stock_plan_id: plan } : {}),
              share_price: usd("1"),
              quantity: rest.toString(),
              x_origin: "BALANCE",
              x_source_security_id: lot.id,
            });
            w.lots.push({ id: balance, holder: lot.holder, outstanding: rest, plan: lot.plan });
          }
          c.tx("TX_STOCK_TRANSFER", date, { security_id: lot.id, quantity: quantity.toString(), resulting_security_ids: [recipient], ...(balance ? { balance_security_id: balance } : {}) });
          w.lots.push({ id: recipient, holder: to, outstanding: quantity, plan: lot.plan });
        }, { source: "app" });
        lot.outstanding = 0n;
        record();
        return;
      }
    }
  });
  return w;
}

const arbWorld = fc.tuple(fc.array(arbStep, { minLength: 1, maxLength: 40, size: "max" }), arbRules).map(([steps, rules]) => buildWorld(steps, rules));

function lastDate(w: World): string {
  return w.dates[w.dates.length - 1] ?? "2020-01-01";
}

function summaryWithoutSeq(state: e.LedgerState): unknown {
  return { ...e.stateSummary(state), ledgerSeq: 0, asKnownAt: 0 };
}

/** The ISO year lots as a walk over the capped timeline (the definition the engine's summing must match). */
function timelineFirstExercisable(state: e.LedgerState, s: e.SecurityState): [number, string][] {
  const byYear = new Map<number, e.Dec>();
  if (s.earlyExercisable) byYear.set(e.yearOf(s.issueDate!), s.issuedQuantity);
  else {
    const cap = s.issuedQuantity.sub(s.cancelledUnvested).clampZero();
    let previous = e.Dec.ZERO;
    for (const event of e.securityVestingTimeline(state, s)) {
      if (event.state !== "ACTIVE") continue;
      const reached = e.Dec.min(event.cumulative, cap);
      const added = reached.sub(previous);
      previous = e.Dec.max(previous, reached);
      if (added.isPositive()) byYear.set(e.yearOf(event.date), (byYear.get(e.yearOf(event.date)) ?? e.Dec.ZERO).add(added));
    }
  }
  return [...byYear].sort((a, b) => a[0] - b[0]).map(([year, shares]) => [year, shares.toString()]);
}

/** The ISO and NSO lots vested by a date, event by event, each year's ISO lots first. */
function timelineVestedLots(state: e.LedgerState, s: e.SecurityState, date: string): { iso: string; nso: string } {
  const split = e.isoSplit(state, s.identity.stakeholderId).find((g) => g.securityId === s.identity.id)!;
  if (s.earlyExercisable) return { iso: split.iso.toString(), nso: split.nso.toString() };
  const vested = e.positionAt(state, s, date).vested;
  const left = new Map(split.years.map((y) => [y.year, y.iso]));
  let iso = e.Dec.ZERO;
  let nso = e.Dec.ZERO;
  let previous = e.Dec.ZERO;
  for (const event of e.securityVestingTimeline(state, s)) {
    if (event.date > date) break;
    if (event.state !== "ACTIVE") continue;
    const reached = e.Dec.min(event.cumulative, vested);
    const added = reached.sub(previous).clampZero();
    previous = e.Dec.max(previous, reached);
    const year = e.yearOf(event.date);
    const take = e.Dec.min(added, left.get(year) ?? e.Dec.ZERO);
    left.set(year, (left.get(year) ?? e.Dec.ZERO).sub(take));
    iso = iso.add(take);
    nso = nso.add(added.sub(take));
  }
  return { iso: iso.toString(), nso: nso.toString() };
}

describe("random valid ledgers", () => {
  it("allot ISO lots exactly as walking each grant's timeline would", () => {
    fc.assert(
      fc.property(arbWorld, (w) => {
        const state = w.b.replay(lastDate(w));
        for (const s of state.securities.values()) {
          if (s.identity.subtype !== "OPTION_ISO" || !s.issued) continue;
          expect([...e.firstExercisableByYear(state, s)].sort((a, b) => a[0] - b[0]).map(([year, shares]) => [year, shares.toString()])).toEqual(timelineFirstExercisable(state, s));
          for (const date of [s.issueDate!, ...w.dates.filter((d) => d > s.issueDate!), "2099-12-31"]) {
            const lots = e.isoLotsAvailable(state, s, date);
            const vested = timelineVestedLots(state, s, date);
            const consumedIso = e.Dec.sum(s.exercises.map((x) => x.lotsConsumed.iso));
            const consumedNso = e.Dec.sum(s.exercises.map((x) => x.lotsConsumed.nso));
            let iso = e.Dec.from(vested.iso).sub(consumedIso).clampZero();
            let nso = e.Dec.from(vested.nso).sub(consumedNso).clampZero();
            if (iso.add(nso).lt(lots.total)) nso = lots.total.sub(iso);
            iso = e.Dec.min(iso, lots.total);
            nso = e.Dec.min(nso, lots.total);
            expect([lots.iso.toString(), lots.nso.toString()]).toEqual([iso.toString(), nso.toString()]);
          }
        }
      }),
      { numRuns: 60 },
    );
  }, PROPERTY_TIMEOUT);

  it("replay without errors, never go negative, and agree with the naive model", () => {
    fc.assert(
      fc.property(arbWorld, (w) => {
        const asOf = lastDate(w);
        const state = w.b.replay(asOf, { today: asOf });
        expect(state.violations.filter((v) => v.severity === "error")).toEqual([]);
        expect(e.checkInvariants(state)).toEqual([]);
        for (const g of w.grants) {
          const s = state.securities.get(g.id)!;
          expect([s.outstanding, s.exercised, s.cancelledUnvested, s.cancelledVested].map(String)).toEqual([g.outstanding, g.exercised, g.cancelledUnvested, g.cancelledVested].map(String));
          expect(e.positionAt(state, s, asOf).vestedOutstanding.toString()).toBe(vestedOutstanding(g, asOf).toString());
        }
        for (const lot of w.lots) expect(state.securities.get(lot.id)!.outstanding.toString()).toBe(lot.outstanding.toString());
        const metrics = e.computeMetrics(state);
        const stock = w.lots.reduce((s, l) => s + l.outstanding, 0n);
        const options = w.grants.reduce((s, g) => s + g.outstanding, 0n);
        const available = w.pool - planUsed(w);
        expect(metrics.issuedAndOutstanding.toString()).toBe(stock.toString());
        expect(metrics.plans[0]!.availableToGrant.toString()).toBe(available.toString());
        expect(metrics.fullyDiluted.toString()).toBe((stock + options + (available > 0n ? available : 0n)).toString());
        expect(e.checkCapTableIdentity(metrics)).toEqual([]);
        // Every as-of date along the way: no negative positions.
        for (const date of w.dates) expect(e.checkPositions(w.b.replay(date))).toEqual([]);
      }),
      { numRuns: 120 },
    );
  }, PROPERTY_TIMEOUT);

  it("are monotone in the as-of date: consumed quantities and vesting never go back", () => {
    fc.assert(
      fc.property(arbWorld, (w) => {
        let previous: e.LedgerState | null = null;
        for (const date of w.dates) {
          const state = w.b.replay(date);
          if (previous !== null) {
            for (const [id, s] of state.securities) {
              const before = previous.securities.get(id)!;
              const consumed = (x: e.SecurityState) => x.exercised.add(x.cancelled).add(x.transferred).add(x.movedToBalance);
              expect(consumed(s).gte(consumed(before))).toBe(true);
              expect(s.issuedQuantity.gte(before.issuedQuantity)).toBe(true);
              if (s.issued && before.issued) expect(e.positionAt(state, s, date).vested.gte(e.positionAt(previous, before, previous.asOf).vested)).toBe(true);
            }
          }
          previous = state;
        }
      }),
      { numRuns: 60 },
    );
  }, PROPERTY_TIMEOUT);

  it("answer as known at a seq exactly like the ledger prefix up to it, in any input order", () => {
    fc.assert(
      fc.property(arbWorld, fc.nat(), fc.nat(), (w, pick, seed) => {
        const asOf = lastDate(w);
        const commands = w.b.reference.commands;
        const boundary = commands[pick % commands.length]!.lastSeq;
        const known = w.b.replay(asOf, { asKnownAt: boundary });
        const prefix = e.replay(w.b.reference, w.b.transactions.filter((t) => t.seq <= boundary), { asOf });
        expect(summaryWithoutSeq(known)).toEqual(summaryWithoutSeq(prefix));
        const shuffled = [...w.b.transactions].sort((x, y) => ((x.seq * 7919 + seed) % 101) - ((y.seq * 7919 + seed) % 101));
        expect(e.stateSummary(e.replay(w.b.reference, shuffled, { asOf }))).toEqual(e.stateSummary(w.b.replay(asOf)));
        expect(e.replayHash(e.replay(w.b.reference, shuffled, { asOf }))).toBe(e.replayHash(w.b.replay(asOf)));
      }),
      { numRuns: 80 },
    );
  }, PROPERTY_TIMEOUT);

  it("treat a reversed command as never having happened, at every as-of date, once its dependents are reversed first", () => {
    fc.assert(
      fc.property(arbWorld, fc.nat(), (w, pick) => {
        if (w.commandLabels.length === 0) return;
        const commands = [...w.b.reference.commands];
        // Edges for every command, computed as the writer would: from the dry run of the ledger through it.
        const edges: e.DependencyEdge[] = [];
        for (const command of commands) {
          const dryRun = e.replay(w.b.reference, w.b.transactions.filter((t) => t.seq <= command.lastSeq), { asOf: "2099-12-31" });
          edges.push(...e.commandDependencies(dryRun, command.id));
        }
        const target = w.b.commandIds.get(w.commandLabels[pick % w.commandLabels.length]!)!;
        const closure = e.dependentClosure(target, edges, commands);
        // Edge completeness for consumed lots: a later command acting on a lot the target created is in the closure.
        const created = new Set(w.b.reference.securities.filter((s) => s.originCommandId === target).map((s) => s.id));
        for (const tx of w.b.transactions) {
          const security = (tx.payload as { security_id?: string }).security_id;
          if (tx.commandId !== target && security !== undefined && created.has(security)) expect(closure.map((c) => c.id)).toContain(tx.commandId);
        }
        const removed = new Set([target, ...closure.map((c) => c.id)]);
        const without = w.b.transactions.filter((t) => !removed.has(t.commandId));
        const asOf = lastDate(w);
        const introduced = e.violationsIntroduced(w.b.replay(asOf).violations, e.replay(w.b.reference, without, { asOf }).violations);
        if (introduced.length > 0) return; // the replay-without check refuses it (a dependency edges don't express)
        for (const command of closure) w.b.reverse(command.id, asOf);
        w.b.reverse(target, asOf);
        for (const date of [...w.dates, asOf]) {
          const reversed = w.b.replay(date);
          expect(reversed.violations.filter((v) => v.severity === "error")).toEqual([]);
          expect(summaryWithoutSeq(reversed)).toEqual(summaryWithoutSeq(e.replay(w.b.reference, without, { asOf: date })));
        }
        expect(e.verifyCommandSeals(w.b.reference.commands, w.b.transactions)).toEqual([]);
        expect(e.edgesOnReversedCommands(edges, w.b.reference.commands)).toEqual([]);
      }),
      { numRuns: 60 },
    );
  }, PROPERTY_TIMEOUT);

  it("keep a verifiable hash chain that detects any altered row", () => {
    fc.assert(
      fc.property(arbWorld, fc.nat(), (w, pick) => {
        expect(e.verifyChain(w.b.orgId, w.b.rows).ok).toBe(true);
        const index = pick % w.b.rows.length;
        const rows = w.b.rows.map((row, i) => (i === index ? { ...row, recorded_at: row.recorded_at + 1 } : row));
        const result = e.verifyChain(w.b.orgId, rows);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.seq).toBe(w.b.rows[index]!.seq);
        for (const row of w.b.rows) expect(e.parseTransactionRow(row)).toEqual(w.b.transactions.find((t) => t.id === row.id));
      }),
      { numRuns: 60 },
    );
  }, PROPERTY_TIMEOUT);

  it("preserve every holder's FD share through a split with a proportional pool (I7)", () => {
    fc.assert(
      fc.property(arbWorld, fc.constantFrom(2, 3, 5), (w, n) => {
        const asOf = lastDate(w);
        const before = w.b.replay(asOf);
        const splitDate = e.addDays(asOf, 1);
        w.b.command("p:split", (c) => {
          c.tx("TX_STOCK_CLASS_SPLIT", splitDate, { stock_class_id: w.common, split_ratio: { numerator: String(n), denominator: "1" } });
          c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", splitDate, { stock_plan_id: w.plan, shares_reserved: (w.pool * BigInt(n)).toString() });
        });
        const after = w.b.replay(splitDate);
        expect(after.violations.filter((v) => v.severity === "error")).toEqual([]);
        expect(e.checkSplitScaling(before, after, w.common, e.Rational.of(n))).toEqual([]);
        const m0 = e.computeMetrics(before);
        const m1 = e.computeMetrics(after);
        expect(m1.fullyDiluted.toString()).toBe(m0.fullyDiluted.mul(n).toString());
        for (const holder of m0.holders) {
          const later = m1.holders.find((h) => h.stakeholderId === holder.stakeholderId)!;
          expect(later.fullyDilutedPct.eq(holder.fullyDilutedPct)).toBe(true);
        }
        expect(m1.capitalContribution.eq(m0.capitalContribution)).toBe(true);
      }),
      { numRuns: 60 },
    );
  }, PROPERTY_TIMEOUT);
});

describe("back-dated conflicts", () => {
  it("are caught when a later-recorded transaction lands before what it depends on", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 11 }), (monthsEarly) => {
        const b = new LedgerBuilder();
        const common = b.stockClass("bd:CS", "COMMON");
        const plan = b.plan("bd:P", common);
        const holder = b.stakeholder("bd:h", "employee");
        b.command("bd:setup", (c) => {
          c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2024-01-01", { stock_plan_id: plan, shares_reserved: "1000" });
        });
        const terms = b.vestingTerms("bd:vt", { type: "EXPLICIT", events: monthlyEvents(480n, "2024-01-01", 48, 12).map((x) => ({ ...x })) });
        let option = "";
        b.command("bd:grant", (c) => {
          option = c.security("bd:OPT", { family: "EQUITY_COMPENSATION", subtype: "OPTION_NSO", stakeholderId: holder, stockClassId: common, stockPlanId: plan, parentSecurityId: null });
          c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2024-01-01", {
            security_id: option,
            custom_id: "OPT-1",
            stakeholder_id: holder,
            stock_plan_id: plan,
            compensation_type: "OPTION_NSO",
            quantity: "480",
            exercise_price: usd("1"),
            vesting_terms_id: terms.id,
            x_definition_sha256: terms.sha,
            expiration_date: "2034-01-01",
            termination_exercise_windows: [],
          });
        });
        // Recorded later, but dated before the cliff: replay at effective dates refuses it.
        b.command("bd:exercise", (c) => {
          const lot = c.security("bd:CS-1", { family: "STOCK", subtype: "COMMON", stakeholderId: holder, stockClassId: common, stockPlanId: plan, parentSecurityId: option });
          const date = e.addMonths("2025-01-01", -monthsEarly);
          c.tx("TX_EQUITY_COMPENSATION_EXERCISE", date, {
            security_id: option,
            quantity: "1",
            resulting_security_ids: [lot],
            x_portions: [{ portion: "NSO", quantity: "1", security_id: lot }],
            x_lots_consumed: { iso: "0", nso: "1" },
          });
          c.tx("TX_STOCK_ISSUANCE", date, { security_id: lot, custom_id: "CS-1", stakeholder_id: holder, stock_class_id: common, stock_plan_id: plan, share_price: usd("1"), quantity: "1", x_origin: "EXERCISE", x_source_security_id: option, x_portion: "NSO" });
        }, { source: "app" });
        expect(b.replay("2026-01-01").violations.map((v) => v.code)).toContain("EXCEEDS_VESTED_UNEXERCISED");
      }),
      { numRuns: 20 },
    );
  }, PROPERTY_TIMEOUT);
});

describe("ISO $100K lots", () => {
  const arbGrant = fc.record({
    quantity: fc.integer({ min: 1, max: 300000 }),
    cents: fc.integer({ min: 1, max: 500 }),
    day: fc.integer({ min: 0, max: 1500 }),
    shape: fc.integer({ min: 0, max: 2 }),
  });

  it("never allot more than $100,000 of ISO shares a year, conserve shares, and allot as many ISO shares as fit", () => {
    fc.assert(
      fc.property(fc.array(arbGrant, { minLength: 1, maxLength: 6 }), (grants) => {
        const b = new LedgerBuilder();
        const common = b.stockClass("iso:CS", "COMMON");
        const holder = b.stakeholder("iso:h", "employee");
        grants.forEach((g, i) => {
          const date = e.addDays("2022-01-01", g.day);
          const fmv = e.Dec.of(g.cents, 2).toString();
          b.command(`iso:${i}`, (c) => {
            const lot = c.security(`iso:OPT-${i}`, { family: "EQUITY_COMPENSATION", subtype: "OPTION_ISO", stakeholderId: holder, stockClassId: common, stockPlanId: null, parentSecurityId: null });
            const events = g.shape === 1 ? monthlyEvents(BigInt(g.quantity), date, 48, 12) : null;
            const terms = events ? b.vestingTerms(`iso:vt:${i}`, { type: "EXPLICIT", events }) : null;
            c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", date, {
              security_id: lot,
              custom_id: `OPT-${i}`,
              stakeholder_id: holder,
              compensation_type: "OPTION_ISO",
              quantity: String(g.quantity),
              exercise_price: usd(fmv),
              early_exercisable: g.shape === 2,
              ...(terms ? { vesting_terms_id: terms.id, x_definition_sha256: terms.sha } : {}),
              expiration_date: e.addYears(date, 10),
              termination_exercise_windows: [],
              x_fmv: { price_per_share: usd(fmv), valuation_id: null, source: "IMPORTED" },
            });
          });
        });
        const state = b.replay("2030-12-31");
        const split = e.isoSplit(state, holder);
        expect(split).toHaveLength(grants.length);
        const limit = e.Rational.of(100000);
        const used = new Map<number, e.Rational>();
        for (const grant of split) {
          expect(e.Dec.sum(grant.years.map((y) => y.shares)).toString()).toBe(state.securities.get(grant.securityId)!.issuedQuantity.toString());
          for (const year of grant.years) {
            expect(year.iso.add(year.nso).eq(year.shares)).toBe(true);
            const before = used.get(year.year) ?? e.Rational.ZERO;
            const after = before.add(e.Rational.fromDec(year.iso).mul(grant.fmv!));
            expect(after.lte(limit)).toBe(true);
            if (year.nso.isPositive()) expect(after.add(grant.fmv!).gt(limit)).toBe(true); // one more ISO share wouldn't fit
            used.set(year.year, after);
          }
        }
        for (let i = 1; i < split.length; i++) expect(split[i - 1]!.grantDate <= split[i]!.grantDate).toBe(true);
      }),
      { numRuns: 200 },
    );
  }, PROPERTY_TIMEOUT);
});
