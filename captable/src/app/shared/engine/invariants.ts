import { Dec } from "./decimal.ts";
import { definitionSha256 } from "./hashing.ts";
import type { LedgerCommand, LedgerTransaction } from "./ledger.ts";
import { computeMetrics, type CapTableMetrics } from "./metrics.ts";
import { positionAt } from "./positions.ts";
import { Rational } from "./rational.ts";
import { replay, type ReplayOptions } from "./replay.ts";
import type { EngineReference, LedgerState, Violation } from "./state.ts";

/**
 * The invariants of the ledger rules as functions the ledger writer and the tests call. Replay already checks most of them
 * as it goes (I1–I11, by transaction and by date); these check a finished state, a metrics view, a split, command
 * seals, and what reversing a command would break.
 */

function violation(code: string, message: string, extra: Partial<Violation> = {}): Violation {
  return { code, severity: "error", message, ...extra };
}

/** I1 on a finished state: no lot below zero, and vested never above issued (I11). */
export function checkPositions(state: LedgerState): Violation[] {
  const found: Violation[] = [];
  for (const security of state.securities.values()) {
    if (!security.issued) continue;
    const id = security.identity.id;
    if (security.outstanding.isNegative()) found.push(violation("NEGATIVE_POSITION", `Lot ${id} has ${security.outstanding} outstanding`, { securityId: id }));
    const position = positionAt(state, security, state.asOf);
    if (position.vested.gt(security.issuedQuantity)) found.push(violation("VESTED_ABOVE_ISSUED", `Lot ${id} vests more than it issued`, { securityId: id }));
    if (position.vestedOutstanding.add(position.unvestedOutstanding).cmp(security.outstanding.clampZero()) !== 0) {
      found.push(violation("POSITION_SPLIT", `Lot ${id}: vested + unvested outstanding ≠ outstanding`, { securityId: id }));
    }
  }
  return found;
}

/** I12: Σ holder FD + Σ plan available = company FD; Σ holder I&O % = 100% exactly (when anything is outstanding). */
export function checkCapTableIdentity(metrics: CapTableMetrics): Violation[] {
  const found: Violation[] = [];
  const holderFd = Dec.sum(metrics.holders.map((h) => h.fullyDiluted));
  if (!holderFd.add(metrics.planAvailable).eq(metrics.fullyDiluted)) {
    found.push(violation("FD_IDENTITY", `Σ holder FD ${holderFd} + pool ${metrics.planAvailable} ≠ FD ${metrics.fullyDiluted}`));
  }
  if (metrics.issuedAndOutstanding.isPositive()) {
    const total = Rational.sum(metrics.holders.map((h) => h.issuedAndOutstandingPct));
    if (!total.eq(Rational.ONE)) found.push(violation("IO_PERCENT_IDENTITY", `Σ holder I&O % is ${total.toFraction()}, not 1`));
    const stock = Dec.sum(metrics.holders.map((h) => h.stockOutstanding));
    if (!stock.eq(metrics.issuedAndOutstanding)) found.push(violation("IO_IDENTITY", "Σ holder stock ≠ issued and outstanding"));
  }
  const fdPct = Rational.sum(metrics.holders.map((h) => h.fullyDilutedPct)).add(metrics.availablePool.fullyDilutedPct);
  if (metrics.fullyDiluted.isPositive() && !fdPct.eq(Rational.ONE)) {
    found.push(violation("FD_PERCENT_IDENTITY", `Σ holder FD % + pool % is ${fdPct.toFraction()}, not 1`));
  }
  return found;
}

/** Every final-state invariant: replay's own violations, positions and the cap table identities. */
export function checkInvariants(state: LedgerState): Violation[] {
  return [...state.violations, ...checkPositions(state), ...checkCapTableIdentity(computeMetrics(state))];
}

/**
 * I7 for a split of `stockClassId` by `ratio` between two states (before and after it): every lot that was open scales
 * to floor(outstanding × ratio) to the share unit, and authorized shares don't move.
 */
export function checkSplitScaling(before: LedgerState, after: LedgerState, stockClassId: string, ratio: Rational): Violation[] {
  const found: Violation[] = [];
  const beforeClass = before.classes.get(stockClassId);
  const afterClass = after.classes.get(stockClassId);
  if (!beforeClass || !afterClass) return [violation("UNKNOWN_STOCK_CLASS", `No class ${stockClassId}`)];
  const authorizedBefore = beforeClass.authorized?.toString() ?? null;
  const authorizedAfter = afterClass.authorized?.toString() ?? null;
  if (authorizedBefore !== authorizedAfter) found.push(violation("SPLIT_CHANGED_AUTHORIZED", "A split changed authorized shares"));
  for (const [id, prior] of before.securities) {
    if (!prior.issued || prior.closedBy !== null || prior.identity.family === "CONVERTIBLE") continue;
    const delivered = prior.identity.stockClassId ?? (prior.identity.stockPlanId !== null ? before.plans.get(prior.identity.stockPlanId)?.ref.stockClassId : null);
    if (delivered !== stockClassId) continue;
    const expected = Rational.fromDec(prior.outstanding).mul(ratio).floorToUnit(before.shareUnit);
    const actual = after.securities.get(id)?.outstanding ?? Dec.ZERO;
    if (!actual.eq(expected)) found.push(violation("SPLIT_NOT_SCALED", `Lot ${id}: ${actual} after the split, expected ${expected}`, { securityId: id }));
  }
  return found;
}

/**
 * I17: each command wrote exactly `declared_tx_count` transactions in its seq range, and a reversal covers every
 * transaction of its target with one X_REVERSAL.
 */
export function verifyCommandSeals(commands: readonly LedgerCommand[], transactions: readonly LedgerTransaction[]): Violation[] {
  const found: Violation[] = [];
  const byCommand = new Map<string, LedgerTransaction[]>();
  for (const tx of transactions) {
    const list = byCommand.get(tx.commandId) ?? [];
    list.push(tx);
    byCommand.set(tx.commandId, list);
  }
  for (const command of commands) {
    const list = byCommand.get(command.id) ?? [];
    if (list.length !== command.declaredTxCount) {
      found.push(violation("SEAL_COUNT", `Command ${command.id} declared ${command.declaredTxCount} transactions and has ${list.length}`));
    }
    if (list.some((tx) => tx.seq < command.firstSeq || tx.seq > command.lastSeq)) {
      found.push(violation("SEAL_RANGE", `Command ${command.id} has a transaction outside its seq range`));
    }
    if (command.reversesCommandId !== null) {
      const targets = byCommand.get(command.reversesCommandId) ?? [];
      const covered = new Set(list.filter((tx) => tx.type === "X_REVERSAL").map((tx) => tx.reversesTxId));
      if (list.some((tx) => tx.type !== "X_REVERSAL")) found.push(violation("REVERSAL_NOT_PURE", `Reversal ${command.id} carries other transactions`));
      if (targets.length === 0 || targets.some((tx) => !covered.has(tx.id)) || covered.size !== targets.length) {
        found.push(violation("REVERSAL_INCOMPLETE", `Reversal ${command.id} doesn't cover every transaction of ${command.reversesCommandId}`));
      }
    }
  }
  return found;
}

/**
 * Every vesting terms row's stored `definition_sha256` matches its definition. Replay separately compares each grant's
 * embedded hash with the row's stored one.
 */
export function checkVestingTermsHashes(reference: Pick<EngineReference, "vestingTerms">): Violation[] {
  return reference.vestingTerms
    .filter((terms) => definitionSha256(terms.definition) !== terms.definitionSha256)
    .map((terms) => violation("VESTING_TERMS_HASH_MISMATCH", `Vesting terms ${terms.id}: definition_sha256 doesn't match the definition`));
}

/** A stable identity for comparing violations between two replays. */
export function violationKey(v: Violation): string {
  return [v.code, v.securityId ?? "", v.transactionId ?? "", v.effectiveDate ?? ""].join("|");
}

/** Errors present in `after` and not in `before`. */
export function violationsIntroduced(before: readonly Violation[], after: readonly Violation[]): Violation[] {
  const known = new Set(before.map(violationKey));
  return after.filter((v) => v.severity === "error" && !known.has(violationKey(v)));
}

/**
 * The engine's reversal check (the ledger rules): replay the ledger without the target command and report every error that
 * appears, which catches dependencies the edges don't express (an exercise that relied on an acceleration, say).
 */
export function reversalViolations(reference: EngineReference, transactions: readonly LedgerTransaction[], targetCommandId: string, options: ReplayOptions): Violation[] {
  const withTarget = replay(reference, transactions, options);
  const withoutTarget = replay(
    reference,
    transactions.filter((tx) => tx.commandId !== targetCommandId),
    options,
  );
  return violationsIntroduced(withTarget.violations, withoutTarget.violations);
}
