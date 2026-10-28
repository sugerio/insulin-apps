import { isIsoDate, type IsoDate } from "./dates.ts";
import { computeContractualDeadline, contractualDeadline, isoDeadline, leaveEndingEmployment, planTermsOn, repurchaseDeadlineSource, windowSource } from "./deadlines.ts";
import { Dec } from "./decimal.ts";
import { DEPENDENCY_STRENGTH, type DependencyKind } from "./dependencies.ts";
import { EngineError } from "./errors.ts";
import { isoLotsAvailable, precedingIsoGrants } from "./iso.ts";
import { decodeTransaction, denormalizedColumns, type DenormalizedColumn, type LedgerTransaction, type LedgerTransactionOf } from "./ledger.ts";
import { parsePayload, type IssuanceOrigin } from "./payloads.ts";
import { DEFAULT_PLAN_RETURN_RULES, ruleFor, rulesFromPayload, type PoolEvent } from "./plan-rules.ts";
import { hasVestingSchedule, positionAt, vestingInputsFor } from "./positions.ts";
import { Rational } from "./rational.ts";
import type {
  ClassState,
  EngineReference,
  ExerciseRecord,
  LedgerState,
  OutsideIsoGrant,
  PlanState,
  SecurityFamily,
  SecurityIdentity,
  SecurityState,
  SecurityStatus,
  StakeholderRef,
  StakeholderState,
  TerminationRecord,
  TxRef,
  Violation,
  ViolationSeverity,
} from "./state.ts";
import type { TransactionTypeCode } from "./transaction-types.ts";
import { explicitSum, vestedAt } from "./vesting.ts";

/**
 * Replay (the ledger rules): orders the known transactions by (effective_date, seq), skips every transaction that has an
 * X_REVERSAL, substitutes X_CORRECTION payloads, and applies each one effective on or before `asOf`.
 *
 * - `asKnownAt = S` first keeps only seq ≤ S: "what did the cap table say right after seq S" (CL-25). With the
 *   reference's commands it is snapped down to a command boundary, so a view never shows half a command.
 * - Invariants are checked as transactions apply (I1, I3, I9, I10, I11) and at the end of each effective date (I5,
 *   I6), and lineage (I2, I4, I8: resulting and balance lots) once every transaction has applied. Breaks are reported
 *   as violations, not thrown, and the transaction still applies, so the state shows what the ledger says.
 */

export interface ReplayOptions {
  asOf: IsoDate;
  asKnownAt?: number | null;
  /** The org's today: transactions dated after it are violations (I10). Omit for read-only historical views. */
  today?: IsoDate | null;
}

type Kind = "TRANSFER" | "BALANCE" | "EXERCISE" | "CONVERSION" | "REISSUANCE" | "RELEASE" | "STOCK_CONVERSION" | "WARRANT_EXERCISE" | "CONVERTIBLE_CONVERSION";

interface Link {
  kind: Kind;
  tx: LedgerTransaction;
  sourceId: string;
  resulting: readonly string[];
  /** The family and origin each resulting lot must have. */
  resultingFamily: SecurityFamily;
  resultingOrigins: ReadonlySet<string>;
  /** Exact total of the resulting lots, or a [min, max] range (stock conversions round down, net exercise yields fewer). */
  expected: Dec | { min: Dec; max: Dec } | null;
  balanceId: string | null;
  expectedBalance: Dec;
  portions?: { portion: "ISO" | "NSO"; quantity: Dec; securityId: string }[];
}

interface Derived {
  securityId: string;
  family: SecurityFamily;
  origin: string;
  sourceId: string;
  commandId: string;
  date: IsoDate;
  quantity: Dec;
  transactionId: string;
  /** Exercise shares: the ISO or NSO portion the issuance states. */
  portion: "ISO" | "NSO" | null;
}

function newSecurity(identity: SecurityIdentity): SecurityState {
  return {
    identity: { ...identity },
    sourceStakeholderId: identity.stakeholderId,
    issued: false,
    issueDate: null,
    issuance: null,
    origin: null,
    sourceSecurityId: null,
    issuedQuantity: Dec.ZERO,
    outstanding: Dec.ZERO,
    exercised: Dec.ZERO,
    released: Dec.ZERO,
    cancelled: Dec.ZERO,
    cancelledUnvested: Dec.ZERO,
    cancelledVested: Dec.ZERO,
    expired: Dec.ZERO,
    repurchased: Dec.ZERO,
    repurchasedUnvested: Dec.ZERO,
    repurchasedVested: Dec.ZERO,
    forfeited: Dec.ZERO,
    transferred: Dec.ZERO,
    converted: Dec.ZERO,
    reissued: Dec.ZERO,
    movedToBalance: Dec.ZERO,
    retracted: false,
    status: "OUTSTANDING",
    closedBy: null,
    currency: null,
    sharePrice: null,
    exercisePrice: null,
    exercisePriceAtGrant: null,
    basePrice: null,
    compensationType: null,
    expirationDate: null,
    terminationWindows: [],
    earlyExercisable: false,
    fmvAtGrant: null,
    exemption: null,
    capitalContribution: Dec.ZERO,
    vestingTermsId: null,
    vestingStartDate: null,
    vestingBase: null,
    accelerations: [],
    extraVestingEvents: [],
    pauses: [],
    vestingStop: null,
    cancelledEventIds: null,
    executionStatus: "executed",
    executionStatusSetBy: null,
    termination: null,
    computedDeadline: null,
    extendedDeadline: null,
    lastRepurchaseDate: null,
    repurchaseRight: null,
    exercises: [],
    resultingSecurityIds: [],
    openingBalance: null,
    lastActivity: null,
    actors: new Map(),
    boardApprovalDate: null,
    boardApprovalNotRecordedInPulley: false,
    debtCancelled: null,
    legends: [],
    baseEventsCache: null,
  };
}

const DEFAULT_CLASS_TERMS = {
  votesPerShare: Dec.ONE,
  excludeFromFullyDiluted: false,
  seniority: null,
  liquidationPreferenceMultiple: null,
  participation: null,
  participationCapMultiple: null,
  antiDilution: null,
  notRecordedInPulley: [],
};

const COMPENSATION_SUBTYPE: Record<string, string> = {
  OPTION_ISO: "OPTION_ISO",
  OPTION_NSO: "OPTION_NSO",
  RSU: "RSU",
  CSAR: "SAR",
  SSAR: "SAR",
};

const CAPITAL_ORIGINS = new Set<string>(["PURCHASE", "FOUNDERS_STOCK", "RSA", "EXERCISE"]);

const ISSUANCE_TYPES = new Set<string>([
  "TX_STOCK_ISSUANCE",
  "TX_EQUITY_COMPENSATION_ISSUANCE",
  "TX_WARRANT_ISSUANCE",
  "TX_CONVERTIBLE_ISSUANCE",
  "X_MIGRATION_OPENING_BALANCE",
]);

/**
 * What a later command acting on a lot relies on when a transaction of this type acted on it first (the ledger rules):
 * what it consumed, the terms it set (vesting, execution status, price, a termination) or the deadline it set.
 * Acceptances have no effect, so they aren't actors.
 */
const ACTOR_KIND: Partial<Record<TransactionTypeCode, DependencyKind>> = {
  TX_STOCK_TRANSFER: "consumes_security",
  TX_STOCK_CANCELLATION: "consumes_security",
  TX_STOCK_REPURCHASE: "consumes_security",
  TX_STOCK_CONVERSION: "consumes_security",
  TX_STOCK_REISSUANCE: "consumes_security",
  TX_STOCK_RETRACTION: "consumes_security",
  TX_EQUITY_COMPENSATION_EXERCISE: "consumes_security",
  TX_EQUITY_COMPENSATION_CANCELLATION: "consumes_security",
  TX_EQUITY_COMPENSATION_RELEASE: "consumes_security",
  TX_EQUITY_COMPENSATION_TRANSFER: "consumes_security",
  TX_EQUITY_COMPENSATION_RETRACTION: "consumes_security",
  TX_WARRANT_EXERCISE: "consumes_security",
  TX_WARRANT_CANCELLATION: "consumes_security",
  TX_WARRANT_TRANSFER: "consumes_security",
  TX_WARRANT_RETRACTION: "consumes_security",
  TX_CONVERTIBLE_CONVERSION: "consumes_security",
  TX_CONVERTIBLE_CANCELLATION: "consumes_security",
  TX_CONVERTIBLE_TRANSFER: "consumes_security",
  TX_CONVERTIBLE_RETRACTION: "consumes_security",
  TX_STOCK_CLASS_SPLIT: "relies_on_terms",
  TX_VESTING_START: "relies_on_terms",
  TX_VESTING_EVENT: "relies_on_terms",
  TX_VESTING_ACCELERATION: "relies_on_terms",
  X_EQUITY_COMPENSATION_REPRICING: "relies_on_terms",
  X_VESTING_PAUSE: "relies_on_terms",
  X_VESTING_RESUME: "relies_on_terms",
  X_STAKEHOLDER_TERMINATION: "relies_on_terms",
  X_EXECUTION_STATUS: "relies_on_terms",
  X_SECURITY_MODIFICATION: "relies_on_deadline",
  X_MIGRATION_OPENING_BALANCE: "relies_on_terms",
};

/** Actors that change a lot's vesting, and so its ISO lots by year (an unvested cancellation also caps vesting). */
const VESTING_SHAPERS = new Set<string>([
  "TX_STOCK_CLASS_SPLIT",
  "TX_VESTING_START",
  "TX_VESTING_EVENT",
  "TX_VESTING_ACCELERATION",
  "X_VESTING_PAUSE",
  "X_VESTING_RESUME",
  "X_STAKEHOLDER_TERMINATION",
  "X_MIGRATION_OPENING_BALANCE",
]);

class Replayer {
  readonly state: LedgerState;
  private readonly links: Link[] = [];
  private readonly derived: Derived[] = [];
  private readonly classOutstanding = new Map<string, Dec>();
  private readonly planOutstanding = new Map<string, Dec>();
  private stockOutstanding = Dec.ZERO;
  private readonly touchedClasses = new Set<string>();
  private readonly planChecks = new Map<string, { tx: LedgerTransaction; grant: boolean }>();
  private issuerTouched = false;
  private readonly defaultCommonClassId: string | null;
  /** The first issuance date of each lot in the known ledger, so a transaction dated before it is an I10 break. */
  private readonly issueDates = new Map<string, IsoDate>();
  /** The first seq of each known command: a transaction only relies on commands recorded before its own. */
  private readonly commandFirstSeq = new Map<string, number>();
  /**
   * The transaction being applied, the command its interpretation is attributed to (the correction that replaced its
   * payload, else its own), and that command's reads (LedgerState.commandReads).
   */
  private current: LedgerTransaction | null = null;
  private reader: string | null = null;
  private reads: Map<string, DependencyKind> | null = null;
  /** For a corrected transaction, the X_CORRECTION that replaced its payload. */
  private correction: LedgerTransaction | null = null;
  /** The corrections of each command's transactions: a fact a command set is now also the correction's. */
  private readonly correctionsOf = new Map<string, string[]>();

  constructor(private readonly reference: EngineReference, private readonly options: ReplayOptions) {
    if (!isIsoDate(options.asOf)) throw new EngineError("DATE_INVALID", `asOf is not a date: ${String(options.asOf)}`);
    if (options.today != null && !isIsoDate(options.today)) throw new EngineError("DATE_INVALID", "today is not a date");
    const shareUnit = Dec.parse(reference.shareUnit);
    if (!shareUnit.isPositive()) throw new EngineError("SHARE_UNIT", "The share unit must be positive");
    this.state = {
      orgId: reference.orgId,
      asOf: options.asOf,
      asKnownAt: options.asKnownAt ?? null,
      ledgerSeq: 0,
      shareUnit,
      securities: new Map(),
      securitiesByStakeholder: new Map(),
      classes: new Map(),
      plans: new Map(),
      stakeholders: new Map(),
      stakeholderAliases: new Map(),
      stakeholderMergeCommands: new Map(),
      vestingTerms: new Map(),
      issuerAuthorized: null,
      applied: [],
      reversedTransactionIds: new Set(),
      pendingOpeningBalances: new Map(),
      commandReads: new Map(),
      violations: [],
    };
    for (const identity of reference.securities) {
      const security = newSecurity(identity);
      this.state.securities.set(identity.id, security);
      const held = this.state.securitiesByStakeholder.get(identity.stakeholderId);
      if (held) held.push(security);
      else this.state.securitiesByStakeholder.set(identity.stakeholderId, [security]);
    }
    for (const ref of reference.stockClasses) {
      this.state.classes.set(ref.id, {
        ref,
        authorized: null,
        authorizedSetBy: null,
        conversionRatio: Rational.ONE,
        conversionRatioSetBy: null,
        convertsToClassId: null,
        terms: { ...DEFAULT_CLASS_TERMS },
        termsSetBy: null,
        splits: [],
      });
    }
    for (const ref of reference.stockPlans) {
      this.state.plans.set(ref.id, {
        ref,
        poolSize: Dec.ZERO,
        poolSetBy: null,
        termsHistory: [],
        retired: Dec.ZERO,
        returned: Dec.ZERO,
        explicitReturns: Dec.ZERO,
        explicitReturnsBy: [],
        retiredBy: [],
        returnedBy: [],
        grantedGross: Dec.ZERO,
      });
    }
    const displayIds = new Set(reference.securities.map((s) => s.displayId));
    for (const ref of reference.stakeholders) {
      this.state.stakeholders.set(ref.id, { ref, terminations: [], leaves: [], laterTerminations: [], outsideIsoGrants: this.outsideIsoGrants(ref, displayIds) });
    }
    // Each grant's embedded definition hash is compared with the terms row; recomputing every row's hash is the
    // The on-demand verifier checks every stored terms hash; ordinary replay checks only referenced terms.
    for (const terms of reference.vestingTerms) this.state.vestingTerms.set(terms.id, terms);
    const commons = reference.stockClasses.filter((c) => c.classType === "COMMON");
    this.defaultCommonClassId = commons.length === 1 ? commons[0]!.id : null;
  }

  // -------------------------------------------------------------------------
  // Driver

  run(transactions: readonly LedgerTransaction[]): LedgerState {
    const ids = new Set<string>();
    const seqs = new Set<number>();
    for (const tx of transactions) {
      if (ids.has(tx.id)) throw new EngineError("DUPLICATE_TRANSACTION", `Transaction ${tx.id} appears twice`);
      if (seqs.has(tx.seq)) throw new EngineError("DUPLICATE_SEQ", `Seq ${tx.seq} appears twice`);
      ids.add(tx.id);
      seqs.add(tx.seq);
    }
    const asKnownAt = this.snapAsKnownAt(this.options.asKnownAt ?? null);
    this.state.asKnownAt = asKnownAt;
    const known = transactions.filter((tx) => asKnownAt === null || tx.seq <= asKnownAt).sort((a, b) => a.seq - b.seq);
    this.state.ledgerSeq = known.length > 0 ? known[known.length - 1]!.seq : 0;
    const byId = new Map(known.map((tx) => [tx.id, tx]));
    for (const tx of known) if (!this.commandFirstSeq.has(tx.commandId)) this.commandFirstSeq.set(tx.commandId, tx.seq);

    const reversed = this.state.reversedTransactionIds;
    for (const tx of known) {
      if (tx.type !== "X_REVERSAL") continue;
      const target = byId.get(tx.payload.reverses_tx_id);
      if (!target) this.violation("REVERSAL_TARGET_UNKNOWN", "error", "An X_REVERSAL targets an unknown transaction", tx);
      else if (target.seq >= tx.seq) this.violation("REVERSAL_OF_LATER", "error", "An X_REVERSAL targets a later transaction", tx);
      else if (target.type === "X_REVERSAL") this.violation("REVERSAL_OF_REVERSAL", "error", "A reversal can't be reversed", tx);
      else if (reversed.has(target.id)) this.violation("DUPLICATE_REVERSAL", "error", "A transaction is reversed twice", tx);
      else reversed.add(target.id);
    }

    const corrections = new Map<string, LedgerTransaction>();
    const correctedBy = new Map<string, LedgerTransaction>();
    for (const tx of known) {
      if (tx.type !== "X_CORRECTION" || reversed.has(tx.id)) continue;
      const target = byId.get(tx.payload.supersedes_tx_id);
      if (!target || target.seq >= tx.seq) {
        this.violation("CORRECTION_TARGET_UNKNOWN", "error", "An X_CORRECTION targets an unknown or later transaction", tx);
        continue;
      }
      if (target.type === "X_REVERSAL" || target.type === "X_CORRECTION") {
        this.violation("CORRECTION_TARGET_INVALID", "error", "Reversals and corrections can't be corrected", tx);
        continue;
      }
      if (reversed.has(target.id)) continue;
      if (corrections.has(target.id)) this.violation("DUPLICATE_CORRECTION", "error", "A transaction is corrected twice", tx);
      // The corrected transaction is decoded exactly as a row would be, with the target row's columns and the corrected
      // date: the payload schema and every per-type rule (a termination's date is its effective date, …), and the
      // migration-only gate for whoever wrote the correction. The columns can't be rewritten, so a payload that no
      // longer matches them is a change that needs a reversal. It keeps the target's provenance.
      const replacement = tx.payload.replacement_payload;
      let corrected: LedgerTransaction;
      try {
        corrected = decodeTransaction({
          id: target.id,
          seq: target.seq,
          commandId: target.commandId,
          type: target.type,
          effectiveDate: tx.payload.effective_date ?? target.effectiveDate,
          payload: replacement,
          payloadVersion: target.payloadVersion,
          securityId: target.securityId,
          stakeholderId: target.stakeholderId,
          stockClassId: target.stockClassId,
          stockPlanId: target.stockPlanId,
          valuationId: target.valuationId,
          quantity: target.quantity,
          amount: target.amount,
          currency: target.currency,
          reversesTxId: target.reversesTxId,
          supersedesTxId: target.supersedesTxId,
          source: tx.source,
        });
      } catch (error) {
        const columns = denormalizedColumns(replacement);
        const changed = (Object.keys(columns) as DenormalizedColumn[]).filter((column) => columns[column] !== target[column]);
        if (error instanceof EngineError && error.code === "COLUMN_PAYLOAD_MISMATCH" && changed.length > 0) {
          this.violation("CORRECTION_CHANGES_COLUMNS", "error", `A correction can't change ${changed.join(", ")}: reverse the command and record it again`, tx);
        } else {
          this.violation("CORRECTION_PAYLOAD_INVALID", "error", error instanceof Error ? error.message : String(error), tx);
        }
        continue;
      }
      corrections.set(target.id, { ...corrected, source: target.source });
      correctedBy.set(target.id, tx);
      this.correctionsOf.set(target.commandId, [...(this.correctionsOf.get(target.commandId) ?? []), tx.commandId]);
    }

    const today = this.options.today ?? null;
    if (today !== null) {
      for (const tx of known) {
        if (tx.effectiveDate > today) this.violation("FUTURE_EFFECTIVE_DATE", "error", `Effective ${tx.effectiveDate}, after today (${today})`, tx);
      }
    }

    const effective = known
      .filter((tx) => tx.type !== "X_REVERSAL" && tx.type !== "X_CORRECTION" && !reversed.has(tx.id))
      .map((tx) => corrections.get(tx.id) ?? tx)
      .sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : a.seq - b.seq));

    // A merge is an identity fact, not an economic event. Once it is known, it canonicalizes the person before any
    // dated transaction is interpreted, including views whose as-of date precedes the merge transaction's date.
    this.applyIdentityMerges(effective.filter((tx): tx is LedgerTransactionOf<"X_STAKEHOLDER_MERGE"> => tx.type === "X_STAKEHOLDER_MERGE"));

    for (const tx of effective) {
      const issued = ISSUANCE_TYPES.has(tx.type) ? (tx.payload as { security_id: string }).security_id : null;
      if (issued !== null && !this.issueDates.has(issued)) this.issueDates.set(issued, tx.effectiveDate);
    }

    const asOf = this.state.asOf;
    for (const tx of effective) {
      if (tx.effectiveDate <= asOf) continue;
      if (tx.type === "X_MIGRATION_OPENING_BALANCE") {
        const pending = this.state.pendingOpeningBalances.get(tx.payload.security_id);
        if (pending === undefined || tx.effectiveDate < pending) this.state.pendingOpeningBalances.set(tx.payload.security_id, tx.effectiveDate);
      } else if (tx.type === "X_STAKEHOLDER_TERMINATION") {
        this.stakeholder(tx, tx.payload.stakeholder_id)?.laterTerminations.push(this.terminationRecord(tx));
      }
    }

    let currentDate: IsoDate | null = null;
    for (const tx of effective) {
      if (tx.effectiveDate > asOf) break;
      if (currentDate !== null && tx.effectiveDate !== currentDate) this.endOfDate(currentDate);
      currentDate = tx.effectiveDate;
      this.current = tx;
      this.correction = correctedBy.get(tx.id) ?? null;
      this.reader = this.correction?.commandId ?? tx.commandId;
      this.reads = this.state.commandReads.get(this.reader) ?? new Map();
      this.state.commandReads.set(this.reader, this.reads);
      // A correction relies on the transaction it corrects; what the corrected payload reads is the correction's.
      if (this.correction !== null) this.read("consumes_security", tx.commandId);
      this.apply(tx);
      this.state.applied.push(tx);
    }
    this.current = null;
    this.reader = null;
    this.reads = null;
    this.correction = null;
    for (const [commandId, reads] of this.state.commandReads) if (reads.size === 0) this.state.commandReads.delete(commandId);
    if (currentDate !== null) this.endOfDate(currentDate);
    this.checkLinks();
    return this.state;
  }

  /**
   * Outside ISO grants as entered on the stakeholder; an invalid one is refused (an error), never guessed at. Ids are
   * the test's tie-break on a shared grant date, so each is unique and differs from every display id in the org; a
   * repeated or colliding grant is refused and counted once at most.
   */
  private outsideIsoGrants(ref: StakeholderRef, displayIds: ReadonlySet<string>): OutsideIsoGrant[] {
    const grants: OutsideIsoGrant[] = [];
    const seen = new Set<string>();
    for (const grant of ref.outsideIsoGrants ?? []) {
      if (seen.has(grant.id) || displayIds.has(grant.id)) {
        const why = seen.has(grant.id) ? "is entered twice" : "is also a security's display id";
        this.violation("OUTSIDE_ISO_GRANT_INVALID", "error", `Outside ISO grant id ${grant.id} of stakeholder ${ref.id} ${why}: ids order same-day grants, so each must be unique`);
        continue;
      }
      seen.add(grant.id);
      const valid =
        typeof grant.id === "string" &&
        grant.id.length > 0 &&
        isIsoDate(grant.grantDate) &&
        Dec.isCanonical(grant.fmvPerShare) &&
        grant.fmvPerShare !== "0" &&
        grant.firstExercisable.every((y) => Number.isSafeInteger(y.year) && y.year >= 1 && Dec.isCanonical(y.shares));
      if (!valid) {
        this.violation("OUTSIDE_ISO_GRANT_INVALID", "error", `Outside ISO grant ${String(grant.id)} of stakeholder ${ref.id} needs a grant date, an FMV above 0 and shares by year`);
        continue;
      }
      const byYear = new Map<number, Dec>();
      for (const y of grant.firstExercisable) byYear.set(y.year, (byYear.get(y.year) ?? Dec.ZERO).add(Dec.parse(y.shares)));
      grants.push({ id: grant.id, grantDate: grant.grantDate, fmv: Rational.fromDec(Dec.parse(grant.fmvPerShare)), firstExercisable: byYear });
    }
    return grants;
  }

  // -------------------------------------------------------------------------
  // Dependencies (the ledger rules): what each transaction reads from other commands

  /**
   * The transaction being applied reads a fact `commandId` set. Edges point from the later-recorded command to the
   * earlier one: usually the reader relies on the fact, but a fact recorded after its reader (a correction, or a
   * back-dated command) re-interprets the reader, so that later command relies on the reader instead. When a
   * correction replaced the payload of one of the fact's transactions, the fact is the correction's as well.
   */
  private read(kind: DependencyKind, commandId: string | null | undefined): void {
    const reader = this.reader;
    if (reader === null || this.reads === null || !commandId || commandId === reader) return;
    const own = this.commandFirstSeq.get(reader);
    const other = this.commandFirstSeq.get(commandId);
    if (own === undefined || other === undefined) return;
    const [from, to, edgeKind] = other < own ? [reader, commandId, kind] : [commandId, reader, "relies_on_terms" as const];
    const reads = this.state.commandReads.get(from) ?? new Map<string, DependencyKind>();
    this.state.commandReads.set(from, reads);
    const existing = reads.get(to);
    if (existing === undefined || DEPENDENCY_STRENGTH[edgeKind] > DEPENDENCY_STRENGTH[existing]) reads.set(to, edgeKind);
    for (const correction of this.correctionsOf.get(commandId) ?? []) this.read(kind, correction);
  }

  /** Acting on a lot reads what issued it and what every earlier command did to it. */
  private readLot(security: SecurityState): void {
    this.read("consumes_security", security.issuance?.commandId ?? security.identity.originCommandId);
    for (const [commandId, actor] of security.actors) this.read(actor.kind, commandId);
  }

  /** Records the current transaction's command as an actor on the lot, for the commands after it. */
  private actOn(tx: LedgerTransaction, security: SecurityState, shaper = VESTING_SHAPERS.has(tx.type), kind = ACTOR_KIND[tx.type]): void {
    if (kind === undefined || security.issuance?.commandId === tx.commandId) return;
    const existing = security.actors.get(tx.commandId);
    security.actors.set(tx.commandId, {
      kind: existing !== undefined && DEPENDENCY_STRENGTH[existing.kind] > DEPENDENCY_STRENGTH[kind] ? existing.kind : kind,
      shaper: (existing?.shaper ?? false) || shaper,
    });
  }

  private snapAsKnownAt(asKnownAt: number | null): number | null {
    if (asKnownAt === null || !this.reference.commands) return asKnownAt;
    let snapped = 0;
    for (const command of this.reference.commands) {
      if (command.lastSeq <= asKnownAt && command.lastSeq > snapped) snapped = command.lastSeq;
    }
    return snapped;
  }

  // -------------------------------------------------------------------------
  // Helpers

  private violation(code: string, severity: ViolationSeverity, message: string, tx?: LedgerTransaction, securityId?: string): void {
    const violation: Violation = { code, severity, message };
    if (tx) {
      violation.transactionId = tx.id;
      violation.effectiveDate = tx.effectiveDate;
    }
    if (securityId !== undefined) violation.securityId = securityId;
    this.state.violations.push(violation);
  }

  /** Product rules that imported history may carry as reviewed exceptions are warnings there, errors elsewhere. */
  private importTolerant(tx: LedgerTransaction): ViolationSeverity {
    return tx.source === "import" ? "warning" : "error";
  }

  private ref(tx: LedgerTransaction): TxRef {
    return { transactionId: tx.id, commandId: tx.commandId, date: tx.effectiveDate };
  }

  private security(tx: LedgerTransaction, id: string, family?: SecurityFamily): SecurityState | null {
    const security = this.state.securities.get(id);
    if (!security) {
      this.violation("UNKNOWN_SECURITY", "error", `No security ${id} in this org`, tx, id);
      return null;
    }
    if (family !== undefined && security.identity.family !== family) {
      this.violation("FAMILY_MISMATCH", "error", `${tx.type} acts on a ${security.identity.family} lot`, tx, id);
      return null;
    }
    this.readStakeholderIdentity(security.sourceStakeholderId);
    security.lastActivity = tx.effectiveDate;
    return security;
  }

  /**
   * I9 and I10: the lot is issued and not closed. Replay runs in effective order, so a transaction dated before its
   * lot's issue meets an unissued lot; the known issue date tells that case (I10) from a lot never issued.
   */
  private open(tx: LedgerTransaction, security: SecurityState): boolean {
    const id = security.identity.id;
    if (!security.issued) {
      const issueDate = this.issueDates.get(id);
      if (issueDate !== undefined && issueDate > tx.effectiveDate) {
        this.violation("BEFORE_ISSUE_DATE", "error", `${tx.type} is dated before the lot's issue date ${issueDate}`, tx, id);
      } else {
        this.violation("NOT_ISSUED", "error", `${tx.type} on a lot that hasn't been issued`, tx, id);
      }
      return false;
    }
    if (security.closedBy !== null) {
      this.violation("LOT_CLOSED", "error", `${tx.type} on a closed lot (closed by ${security.closedBy.type})`, tx, id);
      return false;
    }
    this.readLot(security);
    this.actOn(tx, security);
    return true;
  }

  private stakeholder(tx: LedgerTransaction, id: string): StakeholderState | null {
    this.readStakeholderIdentity(id);
    const stakeholder = this.state.stakeholders.get(this.resolveStakeholder(id));
    if (!stakeholder) {
      this.violation("UNKNOWN_STAKEHOLDER", "error", `No stakeholder ${id} in this org`, tx);
      return null;
    }
    return stakeholder;
  }

  private resolveStakeholder(id: string): string {
    let current = id;
    const seen = new Set<string>();
    while (this.state.stakeholderAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.state.stakeholderAliases.get(current)!;
    }
    return current;
  }

  /** Any command interpreted through a merged identity relies on the merge fact and must be reversed first. */
  private readStakeholderIdentity(id: string): void {
    const resolved = this.resolveStakeholder(id);
    for (const [source, commandId] of this.state.stakeholderMergeCommands) {
      if (this.resolveStakeholder(source) === resolved) this.read("relies_on_terms", commandId);
    }
  }

  private applyIdentityMerges(merges: readonly LedgerTransactionOf<"X_STAKEHOLDER_MERGE">[]): void {
    for (const tx of [...merges].sort((a, b) => a.seq - b.seq)) {
      const source = tx.payload.merged_stakeholder_id;
      const target = this.resolveStakeholder(tx.payload.surviving_stakeholder_id);
      const sourceState = this.state.stakeholders.get(source);
      const targetState = this.state.stakeholders.get(target);
      if (!sourceState || !targetState) {
        this.violation("UNKNOWN_STAKEHOLDER", "error", "A stakeholder merge names a record outside this org", tx);
        continue;
      }
      if (source === target || this.state.stakeholderAliases.has(source)) {
        this.violation("STAKEHOLDER_MERGE_INVALID", "error", "A stakeholder can be merged only once into another record", tx);
        continue;
      }
      if (sourceState.ref.kind !== targetState.ref.kind) {
        this.violation("STAKEHOLDER_KIND_MISMATCH", "error", "Merged stakeholder records must have the same kind", tx);
        continue;
      }
      this.state.stakeholderAliases.set(source, target);
      this.state.stakeholderMergeCommands.set(source, tx.commandId);
      const outside = new Map(targetState.outsideIsoGrants.map((grant) => [grant.id, grant]));
      for (const grant of sourceState.outsideIsoGrants) if (!outside.has(grant.id)) outside.set(grant.id, grant);
      targetState.outsideIsoGrants = [...outside.values()];
      this.state.stakeholders.delete(source);
    }
    if (this.state.stakeholderAliases.size === 0) return;
    this.state.securitiesByStakeholder.clear();
    for (const security of this.state.securities.values()) {
      const stakeholderId = this.resolveStakeholder(security.sourceStakeholderId);
      security.identity = { ...security.identity, stakeholderId };
      const held = this.state.securitiesByStakeholder.get(stakeholderId);
      if (held) held.push(security);
      else this.state.securitiesByStakeholder.set(stakeholderId, [security]);
    }
  }

  private stockClass(tx: LedgerTransaction, id: string): ClassState | null {
    const stockClass = this.state.classes.get(id);
    if (!stockClass) this.violation("UNKNOWN_STOCK_CLASS", "error", `No stock class ${id} in this org`, tx);
    return stockClass ?? null;
  }

  private plan(tx: LedgerTransaction, id: string): PlanState | null {
    const plan = this.state.plans.get(id);
    if (!plan) this.violation("UNKNOWN_STOCK_PLAN", "error", `No stock plan ${id} in this org`, tx);
    return plan ?? null;
  }

  private changeOutstanding(security: SecurityState, delta: Dec): void {
    if (delta.isZero()) return;
    security.outstanding = security.outstanding.add(delta);
    const identity = security.identity;
    if (identity.family === "STOCK" && identity.stockClassId !== null) {
      this.classOutstanding.set(identity.stockClassId, (this.classOutstanding.get(identity.stockClassId) ?? Dec.ZERO).add(delta));
      this.stockOutstanding = this.stockOutstanding.add(delta);
      this.touchedClasses.add(identity.stockClassId);
      this.issuerTouched = true;
    }
    if ((identity.family === "EQUITY_COMPENSATION" || identity.family === "STOCK") && identity.stockPlanId !== null) {
      this.planOutstanding.set(identity.stockPlanId, (this.planOutstanding.get(identity.stockPlanId) ?? Dec.ZERO).add(delta));
    }
  }

  /** Takes `quantity` from a lot's outstanding (I1: never below zero). */
  private take(tx: LedgerTransaction, security: SecurityState, quantity: Dec): void {
    if (quantity.gt(security.outstanding)) {
      this.violation("NEGATIVE_POSITION", "error", `${tx.type} takes ${quantity} from ${security.outstanding} outstanding`, tx, security.identity.id);
    }
    this.changeOutstanding(security, quantity.neg());
  }

  private close(tx: LedgerTransaction, security: SecurityState, status: SecurityStatus): void {
    security.status = status;
    security.closedBy = { ...this.ref(tx), type: tx.type };
  }

  private closeIfEmpty(tx: LedgerTransaction, security: SecurityState, status: SecurityStatus): void {
    if (!security.outstanding.isPositive()) this.close(tx, security, status);
  }

  /** Moves a partial lot's remainder to its balance lot and closes it (OCF's balance pattern, I2). */
  private moveToBalance(tx: LedgerTransaction, security: SecurityState, balanceId: string | undefined, status: SecurityStatus, family: SecurityFamily): void {
    if (balanceId === undefined) {
      this.closeIfEmpty(tx, security, status);
      return;
    }
    const remainder = security.outstanding.clampZero();
    security.movedToBalance = security.movedToBalance.add(remainder);
    this.changeOutstanding(security, remainder.neg());
    this.close(tx, security, status);
    this.links.push({
      kind: "BALANCE",
      tx,
      sourceId: security.identity.id,
      resulting: [],
      resultingFamily: family,
      resultingOrigins: new Set(),
      expected: null,
      balanceId,
      expectedBalance: remainder,
    });
  }

  private rulesFor(tx: LedgerTransaction, plan: PlanState) {
    const terms = planTermsOn(this.state, plan.ref.id, tx.effectiveDate);
    if (terms) {
      this.read("relies_on_terms", terms.commandId);
      return terms.rules;
    }
    this.violation("PLAN_TERMS_MISSING", "warning", `No plan terms in force for ${plan.ref.name} on ${tx.effectiveDate}; the default rules apply`, tx);
    return DEFAULT_PLAN_RETURN_RULES;
  }

  private poolEvent(tx: LedgerTransaction, security: SecurityState, event: PoolEvent, quantity: Dec): void {
    if (!quantity.isPositive() || security.identity.stockPlanId === null) return;
    const plan = this.state.plans.get(security.identity.stockPlanId);
    if (!plan) return;
    // The plan terms whose rule decided it are part of the outcome's provenance, with the transaction itself.
    const terms = planTermsOn(this.state, plan.ref.id, tx.effectiveDate);
    const decidedBy = terms === null ? [this.ref(tx)] : [this.ref(tx), terms];
    if (ruleFor(event, this.rulesFor(tx, plan)) === "RETIRE") {
      plan.retired = plan.retired.add(quantity);
      plan.retiredBy.push(...decidedBy);
    } else {
      plan.returned = plan.returned.add(quantity);
      plan.returnedBy.push(...decidedBy);
    }
  }

  private checkIdentity(tx: LedgerTransaction, security: SecurityState, field: string, payloadValue: string | null, identityValue: string | null): void {
    if (payloadValue !== identityValue) {
      this.violation("IDENTITY_MISMATCH", "error", `${tx.type}: ${field} differs from the security's identity row`, tx, security.identity.id);
    }
  }

  /**
   * The identity row names the command that created the lot; dependencies and reversal provenance trust it, so the
   * issuing transaction must belong to that command.
   */
  private checkOrigin(tx: LedgerTransaction, security: SecurityState): void {
    if (security.identity.originCommandId !== tx.commandId) {
      this.violation(
        "ORIGIN_COMMAND_MISMATCH",
        "error",
        `The lot's identity row names command ${security.identity.originCommandId} as its origin, but it is issued by command ${tx.commandId}`,
        tx,
        security.identity.id,
      );
    }
  }

  /** Board approval and the migrated descriptive fields of an issuance (the migration rules). */
  private setIssuanceRecord(
    security: SecurityState,
    p: {
      board_approval_date?: string | undefined;
      x_board_approval_not_recorded_in_pulley?: true | undefined;
      x_debt_cancelled?: { amount: string } | undefined;
      x_legends?: { legend_id: string; name: string; text: string }[] | undefined;
    },
  ): void {
    security.boardApprovalDate = p.board_approval_date ?? null;
    security.boardApprovalNotRecordedInPulley = p.x_board_approval_not_recorded_in_pulley === true;
    security.debtCancelled = p.x_debt_cancelled ? Dec.parse(p.x_debt_cancelled.amount) : null;
    security.legends = (p.x_legends ?? []).map((legend) => ({ legendId: legend.legend_id, name: legend.name, text: legend.text }));
  }

  private setVesting(tx: LedgerTransaction, security: SecurityState, vestingTermsId: string | undefined, sha: string | undefined, quantity: Dec): void {
    if (vestingTermsId === undefined) return;
    const terms = this.state.vestingTerms.get(vestingTermsId);
    if (!terms) {
      this.violation("UNKNOWN_VESTING_TERMS", "error", `No vesting terms ${vestingTermsId}`, tx, security.identity.id);
      return;
    }
    if (terms.definitionSha256 !== sha) {
      this.violation("VESTING_DEFINITION_MISMATCH", "error", "x_definition_sha256 doesn't match the vesting terms", tx, security.identity.id);
    }
    if (terms.definition.type === "EXPLICIT" && !explicitSum(terms.definition).eq(quantity)) {
      this.violation("VESTING_SUM_MISMATCH", "error", "Explicit vesting events don't sum to the grant quantity", tx, security.identity.id);
    }
    security.vestingTermsId = vestingTermsId;
    security.vestingBase = { quantity, splitRatio: Rational.ONE };
    security.baseEventsCache = null;
  }

  /** Starts a lot's life: issued quantity, issue date and the derived-lot bookkeeping. */
  private issue(tx: LedgerTransaction, security: SecurityState, quantity: Dec, origin: IssuanceOrigin | "GRANT", sourceId: string | undefined): boolean {
    if (security.issued) {
      this.violation("DUPLICATE_ISSUANCE", "error", "The lot is already issued", tx, security.identity.id);
      return false;
    }
    this.checkOrigin(tx, security);
    security.issued = true;
    security.issueDate = tx.effectiveDate;
    security.issuance = this.ref(tx);
    security.issuedQuantity = quantity;
    security.origin = origin;
    security.sourceSecurityId = sourceId ?? null;
    this.changeOutstanding(security, quantity);
    if (sourceId !== undefined) {
      this.derived.push({
        securityId: security.identity.id,
        family: security.identity.family,
        origin,
        sourceId,
        commandId: tx.commandId,
        date: tx.effectiveDate,
        quantity,
        transactionId: tx.id,
        portion: tx.type === "TX_STOCK_ISSUANCE" ? (tx.payload.x_portion ?? null) : null,
      });
      if (security.identity.parentSecurityId !== null && security.identity.parentSecurityId !== sourceId) {
        this.violation("LINEAGE_MISMATCH", "error", "The lot's parent differs from its source security", tx, security.identity.id);
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Transactions

  private apply(tx: LedgerTransaction): void {
    switch (tx.type) {
      case "TX_STOCK_ISSUANCE":
        return this.stockIssuance(tx);
      case "TX_STOCK_TRANSFER":
        return this.transfer(tx, "STOCK", tx.payload.security_id, Dec.parse(tx.payload.quantity), tx.payload.resulting_security_ids, tx.payload.balance_security_id);
      case "TX_EQUITY_COMPENSATION_TRANSFER":
        return this.transfer(tx, "EQUITY_COMPENSATION", tx.payload.security_id, Dec.parse(tx.payload.quantity), tx.payload.resulting_security_ids, tx.payload.balance_security_id);
      case "TX_WARRANT_TRANSFER":
        return this.transfer(tx, "WARRANT", tx.payload.security_id, Dec.parse(tx.payload.quantity), tx.payload.resulting_security_ids, tx.payload.balance_security_id);
      case "TX_CONVERTIBLE_TRANSFER":
        return this.transfer(tx, "CONVERTIBLE", tx.payload.security_id, Dec.parse(tx.payload.amount.amount), tx.payload.resulting_security_ids, tx.payload.balance_security_id);
      case "TX_STOCK_CANCELLATION":
        return this.stockCancellation(tx);
      case "TX_STOCK_REPURCHASE":
        return this.stockRepurchase(tx);
      case "TX_STOCK_CONVERSION":
        return this.stockConversion(tx);
      case "TX_STOCK_REISSUANCE":
        return this.stockReissuance(tx);
      case "TX_STOCK_RETRACTION":
        return this.retraction(tx, "STOCK");
      case "TX_EQUITY_COMPENSATION_RETRACTION":
        return this.retraction(tx, "EQUITY_COMPENSATION");
      case "TX_WARRANT_RETRACTION":
        return this.retraction(tx, "WARRANT");
      case "TX_CONVERTIBLE_RETRACTION":
        return this.retraction(tx, "CONVERTIBLE");
      case "TX_STOCK_ACCEPTANCE":
        return this.acceptance(tx, "STOCK");
      case "TX_EQUITY_COMPENSATION_ACCEPTANCE":
        return this.acceptance(tx, "EQUITY_COMPENSATION");
      case "TX_WARRANT_ACCEPTANCE":
        return this.acceptance(tx, "WARRANT");
      case "TX_CONVERTIBLE_ACCEPTANCE":
        return this.acceptance(tx, "CONVERTIBLE");
      case "TX_EQUITY_COMPENSATION_ISSUANCE":
        return this.awardIssuance(tx);
      case "TX_EQUITY_COMPENSATION_EXERCISE":
        return this.awardExercise(tx);
      case "TX_EQUITY_COMPENSATION_CANCELLATION":
        return this.cancellation(tx, "EQUITY_COMPENSATION");
      case "TX_WARRANT_CANCELLATION":
        return this.cancellation(tx, "WARRANT");
      case "TX_EQUITY_COMPENSATION_RELEASE":
        return this.release(tx);
      case "TX_WARRANT_ISSUANCE":
        return this.warrantIssuance(tx);
      case "TX_WARRANT_EXERCISE":
        return this.warrantExercise(tx);
      case "TX_CONVERTIBLE_ISSUANCE":
        return this.convertibleIssuance(tx);
      case "TX_CONVERTIBLE_CONVERSION":
        return this.convertibleConversion(tx);
      case "TX_CONVERTIBLE_CANCELLATION":
        return this.convertibleCancellation(tx);
      case "TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT": {
        const stockClass = this.stockClass(tx, tx.payload.stock_class_id);
        if (!stockClass) return;
        stockClass.authorized = Dec.parse(tx.payload.new_shares_authorized);
        stockClass.authorizedSetBy = this.ref(tx);
        this.touchedClasses.add(stockClass.ref.id);
        return;
      }
      case "TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT": {
        const stockClass = this.stockClass(tx, tx.payload.stock_class_id);
        if (!stockClass) return;
        const r = tx.payload.new_ratio_conversion_mechanism.ratio;
        stockClass.conversionRatio = Rational.fromDec(r.numerator).div(Rational.fromDec(r.denominator));
        stockClass.conversionRatioSetBy = this.ref(tx);
        const target = tx.payload.x_converts_to_stock_class_id ?? this.defaultCommonClassId;
        if (target !== null && !this.state.classes.has(target)) this.violation("UNKNOWN_STOCK_CLASS", "error", "Unknown conversion target class", tx);
        stockClass.convertsToClassId = target;
        return;
      }
      case "TX_STOCK_CLASS_SPLIT":
        return this.split(tx);
      case "TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT":
        if (tx.payload.issuer_id !== this.state.orgId) this.violation("IDENTITY_MISMATCH", "error", "issuer_id isn't this org", tx);
        this.state.issuerAuthorized = Dec.parse(tx.payload.new_shares_authorized);
        this.issuerTouched = true;
        return;
      case "TX_STOCK_PLAN_POOL_ADJUSTMENT": {
        const plan = this.plan(tx, tx.payload.stock_plan_id);
        if (!plan) return;
        plan.poolSize = Dec.parse(tx.payload.shares_reserved);
        plan.poolSetBy = this.ref(tx);
        if (!this.planChecks.get(plan.ref.id)?.grant) this.planChecks.set(plan.ref.id, { tx, grant: false });
        return;
      }
      case "TX_STOCK_PLAN_RETURN_TO_POOL": {
        const plan = this.plan(tx, tx.payload.stock_plan_id);
        if (!plan) return;
        plan.explicitReturns = plan.explicitReturns.add(Dec.parse(tx.payload.quantity));
        plan.explicitReturnsBy.push(this.ref(tx));
        // It returns shares those commands retired: never more than they did (RETURN_EXCEEDS_RETIRED).
        for (const ref of plan.retiredBy) this.read("consumes_security", ref.commandId);
        if (plan.explicitReturns.gt(plan.retired)) {
          this.violation("RETURN_EXCEEDS_RETIRED", "error", "More shares returned to the pool than were retired", tx);
        }
        return;
      }
      case "TX_VESTING_START": {
        const security = this.security(tx, tx.payload.security_id);
        if (!security || !this.open(tx, security)) return;
        security.vestingStartDate = tx.payload.x_vesting_start_date;
        security.baseEventsCache = null;
        return;
      }
      case "TX_VESTING_EVENT": {
        const security = this.security(tx, tx.payload.security_id);
        if (!security || !this.open(tx, security)) return;
        security.extraVestingEvents.push({ id: tx.id, date: tx.effectiveDate, quantity: Dec.parse(tx.payload.x_quantity), kind: "EXPLICIT", source: "computed" });
        security.baseEventsCache = null;
        return;
      }
      case "TX_VESTING_ACCELERATION":
        return this.acceleration(tx);
      case "X_STOCK_CLASS_TERMS": {
        const stockClass = this.stockClass(tx, tx.payload.stock_class_id);
        if (!stockClass) return;
        const p = tx.payload;
        stockClass.terms = {
          votesPerShare: Dec.parse(p.votes_per_share),
          excludeFromFullyDiluted: p.exclude_from_fully_diluted,
          seniority: p.seniority,
          liquidationPreferenceMultiple: p.liquidation_preference_multiple === null ? null : Dec.parse(p.liquidation_preference_multiple),
          participation: p.participation,
          participationCapMultiple: p.participation_cap_multiple === null ? null : Dec.parse(p.participation_cap_multiple),
          antiDilution: p.anti_dilution,
          notRecordedInPulley: [...p.not_recorded_in_pulley],
        };
        stockClass.termsSetBy = this.ref(tx);
        return;
      }
      case "X_STOCK_PLAN_TERMS": {
        const plan = this.plan(tx, tx.payload.stock_plan_id);
        if (!plan) return;
        const p = tx.payload;
        if (p.pour_over_plan_id !== null && (p.pour_over_plan_id === plan.ref.id || !this.state.plans.has(p.pour_over_plan_id))) {
          this.violation("POUR_OVER_INVALID", "error", "The pour-over plan must be another plan of this org", tx);
        }
        plan.termsHistory.push({
          ...this.ref(tx),
          rules: rulesFromPayload(p.return_rules),
          defaultTerminationWindows: [...p.default_termination_windows],
          defaultRepurchaseWindow: p.default_repurchase_window,
          status: p.status,
          pourOverPlanId: p.pour_over_plan_id,
        });
        return;
      }
      case "X_EQUITY_COMPENSATION_REPRICING": {
        const security = this.security(tx, tx.payload.security_id);
        if (!security || !this.open(tx, security)) return;
        if (security.identity.family !== "EQUITY_COMPENSATION" && security.identity.family !== "WARRANT") {
          this.violation("FAMILY_MISMATCH", "error", "Only awards and warrants have an exercise price", tx, security.identity.id);
          return;
        }
        security.exercisePrice = Rational.fromDec(tx.payload.new_exercise_price.amount);
        return;
      }
      case "X_VESTING_PAUSE": {
        const security = this.security(tx, tx.payload.security_id);
        if (!security || !this.open(tx, security)) return;
        if (security.pauses.some((p) => p.to === null)) {
          this.violation("ALREADY_PAUSED", "error", "Vesting is already paused", tx, security.identity.id);
          return;
        }
        security.pauses.push({ from: tx.effectiveDate, to: null });
        return;
      }
      case "X_VESTING_RESUME": {
        const security = this.security(tx, tx.payload.security_id);
        if (!security || !this.open(tx, security)) return;
        const index = security.pauses.findIndex((p) => p.to === null);
        if (index < 0) {
          this.violation("NOT_PAUSED", "error", "Vesting isn't paused", tx, security.identity.id);
          return;
        }
        security.pauses[index] = { from: security.pauses[index]!.from, to: tx.effectiveDate };
        return;
      }
      case "X_STAKEHOLDER_TERMINATION":
        return this.termination(tx);
      case "X_STAKEHOLDER_LEAVE": {
        const stakeholder = this.stakeholder(tx, tx.payload.stakeholder_id);
        if (!stakeholder) return;
        const p = tx.payload;
        if (p.end_date !== null && p.end_date < p.start_date) this.violation("LEAVE_DATES", "error", "A leave can't end before it starts", tx);
        // A leave is identified by its start date. Recording it again (its end once known, or a corrected end or right
        // to return) replaces the earlier record: a leave is corrected by recording its current terms again.
        const leave = { ...this.ref(tx), startDate: p.start_date, endDate: p.end_date, returnGuaranteed: p.return_guaranteed };
        const recorded = stakeholder.leaves.findIndex((other) => other.startDate === p.start_date);
        if (recorded >= 0) stakeholder.leaves[recorded] = leave;
        else stakeholder.leaves.push(leave);
        return;
      }
      case "X_STAKEHOLDER_MERGE":
        return; // consumed before dated replay as an identity fact
      case "X_EXECUTION_STATUS": {
        const security = this.security(tx, tx.payload.security_id);
        if (!security || !this.open(tx, security)) return;
        security.executionStatus = tx.payload.status;
        security.executionStatusSetBy = this.ref(tx);
        return;
      }
      case "X_SECURITY_MODIFICATION":
        return this.modification(tx);
      case "X_MIGRATION_OPENING_BALANCE":
        return this.openingBalance(tx);
      case "X_REVERSAL":
      case "X_CORRECTION":
        return; // consumed before the replay loop
    }
  }

  private stockIssuance(tx: LedgerTransactionOf<"TX_STOCK_ISSUANCE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "STOCK");
    if (!security) return;
    this.checkIdentity(tx, security, "stakeholder_id", p.stakeholder_id, security.sourceStakeholderId);
    this.checkIdentity(tx, security, "stock_class_id", p.stock_class_id, security.identity.stockClassId);
    this.checkIdentity(tx, security, "stock_plan_id", p.stock_plan_id ?? null, security.identity.stockPlanId);
    if (!this.state.classes.has(p.stock_class_id)) this.violation("UNKNOWN_STOCK_CLASS", "error", "Unknown stock class", tx, security.identity.id);
    const quantity = Dec.parse(p.quantity);
    if (!this.issue(tx, security, quantity, p.x_origin, p.x_source_security_id)) return;
    const price = Dec.parse(p.share_price.amount);
    security.sharePrice = price;
    security.currency = p.share_price.currency;
    security.capitalContribution = p.x_capital_contribution
      ? Dec.parse(p.x_capital_contribution.amount)
      : CAPITAL_ORIGINS.has(p.x_origin)
        ? quantity.mul(price)
        : Dec.ZERO;
    security.exemption = p.x_exemption ?? null;
    this.setIssuanceRecord(security, p);
    if (p.x_repurchase_right) {
      security.repurchaseRight = {
        pricePerShare: p.x_repurchase_right.price_per_share === null ? null : Dec.parse(p.x_repurchase_right.price_per_share.amount),
        window: p.x_repurchase_right.window,
      };
    }
    this.setVesting(tx, security, p.vesting_terms_id, p.x_definition_sha256, quantity);
  }

  private awardIssuance(tx: LedgerTransactionOf<"TX_EQUITY_COMPENSATION_ISSUANCE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "EQUITY_COMPENSATION");
    if (!security) return;
    this.checkIdentity(tx, security, "stakeholder_id", p.stakeholder_id, security.sourceStakeholderId);
    this.checkIdentity(tx, security, "stock_plan_id", p.stock_plan_id ?? null, security.identity.stockPlanId);
    if (p.stock_class_id !== undefined && security.identity.stockClassId !== null) {
      this.checkIdentity(tx, security, "stock_class_id", p.stock_class_id, security.identity.stockClassId);
    }
    if (COMPENSATION_SUBTYPE[p.compensation_type] !== security.identity.subtype) {
      this.violation("SUBTYPE_MISMATCH", "error", `${p.compensation_type} doesn't match the lot's subtype ${security.identity.subtype}`, tx, security.identity.id);
    }
    const quantity = Dec.parse(p.quantity);
    const origin = p.x_origin ?? "GRANT";
    if (!this.issue(tx, security, quantity, origin, p.x_source_security_id)) return;
    security.compensationType = p.compensation_type;
    security.exercisePrice = p.exercise_price ? Rational.fromDec(p.exercise_price.amount) : null;
    security.exercisePriceAtGrant = security.exercisePrice;
    security.basePrice = p.base_price ? Rational.fromDec(p.base_price.amount) : null;
    security.currency = p.exercise_price?.currency ?? p.base_price?.currency ?? null;
    security.expirationDate = p.expiration_date;
    security.terminationWindows = [...p.termination_exercise_windows];
    security.earlyExercisable = p.early_exercisable === true;
    security.fmvAtGrant = p.x_fmv ? Rational.fromDec(p.x_fmv.price_per_share.amount) : null;
    security.exemption = p.x_exemption ?? null;
    this.setIssuanceRecord(security, p);
    if (p.compensation_type === "OPTION_ISO" && origin === "GRANT" && (security.fmvAtGrant === null || security.fmvAtGrant.sign() <= 0)) {
      // The $100K test can't classify the grant's lots without it; an import goes to manual review (the ledger rules).
      this.violation("ISO_FMV_REQUIRED", this.importTolerant(tx), "An ISO grant needs its FMV at grant (above 0) for the $100K test", tx, security.identity.id);
    }
    this.setVesting(tx, security, p.vesting_terms_id, p.x_definition_sha256, quantity);
    const planId = security.identity.stockPlanId;
    if (planId !== null) {
      const plan = this.plan(tx, planId);
      if (plan && origin === "GRANT") {
        plan.grantedGross = plan.grantedGross.add(quantity);
        this.planChecks.set(planId, { tx, grant: true });
        const terms = planTermsOn(this.state, planId, tx.effectiveDate);
        this.read("relies_on_terms", terms?.commandId);
        if (terms?.status === "terminated") {
          this.violation("PLAN_TERMINATED", this.importTolerant(tx), "No new grants from a terminated plan", tx, security.identity.id);
        }
      }
    }
  }

  private warrantIssuance(tx: LedgerTransactionOf<"TX_WARRANT_ISSUANCE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "WARRANT");
    if (!security) return;
    this.checkIdentity(tx, security, "stakeholder_id", p.stakeholder_id, security.sourceStakeholderId);
    const quantity = Dec.parse(p.quantity);
    const origin = p.x_origin ?? "GRANT";
    if (!this.issue(tx, security, quantity, origin, p.x_source_security_id)) return;
    security.exercisePrice = p.exercise_price ? Rational.fromDec(p.exercise_price.amount) : null;
    security.exercisePriceAtGrant = security.exercisePrice;
    security.currency = p.exercise_price?.currency ?? p.purchase_price.currency;
    security.expirationDate = p.warrant_expiration_date ?? null;
    security.exemption = p.x_exemption ?? null;
    this.setIssuanceRecord(security, p);
    security.capitalContribution = p.x_capital_contribution
      ? Dec.parse(p.x_capital_contribution.amount)
      : origin === "GRANT"
        ? Dec.parse(p.purchase_price.amount)
        : Dec.ZERO;
    this.setVesting(tx, security, p.vesting_terms_id, p.x_definition_sha256, quantity);
  }

  private convertibleIssuance(tx: LedgerTransactionOf<"TX_CONVERTIBLE_ISSUANCE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "CONVERTIBLE");
    if (!security) return;
    this.checkIdentity(tx, security, "stakeholder_id", p.stakeholder_id, security.sourceStakeholderId);
    const principal = Dec.parse(p.investment_amount.amount);
    const origin = p.x_origin ?? "GRANT";
    if (!this.issue(tx, security, principal, origin, p.x_source_security_id)) return;
    security.currency = p.investment_amount.currency;
    security.exemption = p.x_exemption ?? null;
    this.setIssuanceRecord(security, p);
    // Gross capital: the principal paid in counts from the issue (it is "converted SAFE principal" once converted);
    // a repayment never nets against it, and the conversion shares add nothing (the ledger rules).
    security.capitalContribution = origin === "GRANT" ? principal : Dec.ZERO;
  }

  private transfer(tx: LedgerTransaction, family: SecurityFamily, securityId: string, quantity: Dec, resulting: readonly string[], balanceId: string | undefined): void {
    const security = this.security(tx, securityId, family);
    if (!security || !this.open(tx, security)) return;
    const before = security.outstanding;
    if (quantity.gt(before)) this.violation("NEGATIVE_POSITION", "error", `Transfers ${quantity} of ${before} outstanding`, tx, securityId);
    if (quantity.lt(before) && balanceId === undefined) {
      this.violation("TRANSFER_NEEDS_BALANCE", "error", "A partial transfer moves the rest to a balance lot", tx, securityId);
    }
    security.transferred = security.transferred.add(quantity);
    security.resultingSecurityIds.push(...resulting);
    this.changeOutstanding(security, quantity.neg());
    this.links.push({
      kind: "TRANSFER",
      tx,
      sourceId: securityId,
      resulting,
      resultingFamily: family,
      resultingOrigins: new Set(["TRANSFER"]),
      expected: quantity,
      balanceId: null,
      expectedBalance: Dec.ZERO,
    });
    this.moveToBalance(tx, security, balanceId, "TRANSFERRED", family);
  }

  private stockCancellation(tx: LedgerTransactionOf<"TX_STOCK_CANCELLATION">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "STOCK");
    if (!security || !this.open(tx, security)) return;
    const quantity = Dec.parse(p.quantity);
    const position = positionAt(this.state, security, tx.effectiveDate);
    const unvested = Dec.min(quantity, position.unvestedOutstanding);
    const vested = quantity.sub(unvested);
    security.cancelled = security.cancelled.add(quantity);
    security.cancelledUnvested = security.cancelledUnvested.add(unvested);
    security.cancelledVested = security.cancelledVested.add(vested);
    if (unvested.isPositive()) this.actOn(tx, security, true);
    this.take(tx, security, quantity);
    // Plan shares cancelled leave the plan like repurchased shares, unvested first (the five rules name no other case).
    this.poolEvent(tx, security, "REPURCHASED_UNVESTED_SHARES", unvested);
    this.poolEvent(tx, security, "REPURCHASED_VESTED_SHARES", vested);
    this.moveToBalance(tx, security, p.balance_security_id, "CANCELLED", "STOCK");
  }

  private stockRepurchase(tx: LedgerTransactionOf<"TX_STOCK_REPURCHASE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "STOCK");
    if (!security || !this.open(tx, security)) return;
    const quantity = Dec.parse(p.quantity);
    const position = positionAt(this.state, security, tx.effectiveDate);
    if (p.x_kind === "UNVESTED" && quantity.gt(position.unvestedOutstanding)) {
      this.violation("REPURCHASE_EXCEEDS_UNVESTED", "error", `Repurchases ${quantity} unvested of ${position.unvestedOutstanding}`, tx, security.identity.id);
    }
    if (p.x_kind === "VESTED" && quantity.gt(position.vestedOutstanding)) {
      this.violation("REPURCHASE_EXCEEDS_VESTED", "error", `Buys back ${quantity} vested of ${position.vestedOutstanding}`, tx, security.identity.id);
    }
    if (p.x_kind === "UNVESTED") {
      // The company's right lasts until its deadline (the product rules: an expired right blocks).
      const deadline = repurchaseDeadlineSource(this.state, security);
      this.read("relies_on_terms", deadline.terms?.commandId);
      if (deadline.date !== null && tx.effectiveDate > deadline.date) {
        this.violation("REPURCHASE_AFTER_DEADLINE", this.importTolerant(tx), `The repurchase right ended on ${deadline.date}`, tx, security.identity.id);
      }
      this.actOn(tx, security, true);
    }
    security.repurchased = security.repurchased.add(quantity);
    if (p.x_kind === "UNVESTED") {
      security.repurchasedUnvested = security.repurchasedUnvested.add(quantity);
      if (Dec.parse(p.price.amount).isZero()) security.forfeited = security.forfeited.add(quantity);
    } else security.repurchasedVested = security.repurchasedVested.add(quantity);
    this.take(tx, security, quantity);
    this.poolEvent(tx, security, p.x_kind === "UNVESTED" ? "REPURCHASED_UNVESTED_SHARES" : "REPURCHASED_VESTED_SHARES", quantity);
    this.moveToBalance(tx, security, p.balance_security_id, "REPURCHASED", "STOCK");
  }

  private stockConversion(tx: LedgerTransactionOf<"TX_STOCK_CONVERSION">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "STOCK");
    if (!security || !this.open(tx, security)) return;
    const quantity = Dec.parse(p.quantity_converted);
    const stockClass = this.state.classes.get(security.identity.stockClassId ?? "");
    if (!p.x_ratio) this.read("relies_on_terms", stockClass?.conversionRatioSetBy?.commandId);
    const ratio = p.x_ratio ? Rational.fromDec(p.x_ratio.numerator).div(Rational.fromDec(p.x_ratio.denominator)) : (stockClass?.conversionRatio ?? Rational.ONE);
    security.converted = security.converted.add(quantity);
    security.resultingSecurityIds.push(...p.resulting_security_ids);
    this.take(tx, security, quantity);
    const exact = Rational.fromDec(quantity).mul(ratio);
    this.links.push({
      kind: "STOCK_CONVERSION",
      tx,
      sourceId: security.identity.id,
      resulting: p.resulting_security_ids,
      resultingFamily: "STOCK",
      resultingOrigins: new Set(["CONVERSION"]),
      expected: { min: exact.floorToUnit(this.state.shareUnit), max: exact.roundToUnit(this.state.shareUnit, "CEIL") },
      balanceId: null,
      expectedBalance: Dec.ZERO,
    });
    this.moveToBalance(tx, security, p.balance_security_id, "CONVERTED", "STOCK");
  }

  private stockReissuance(tx: LedgerTransactionOf<"TX_STOCK_REISSUANCE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "STOCK");
    if (!security || !this.open(tx, security)) return;
    const before = security.outstanding;
    security.reissued = security.reissued.add(before);
    security.resultingSecurityIds.push(...p.resulting_security_ids);
    this.changeOutstanding(security, before.neg());
    this.close(tx, security, "CANCELLED");
    this.links.push({
      kind: "REISSUANCE",
      tx,
      sourceId: security.identity.id,
      resulting: p.resulting_security_ids,
      resultingFamily: "STOCK",
      resultingOrigins: new Set(["REISSUANCE"]),
      expected: before,
      balanceId: null,
      expectedBalance: Dec.ZERO,
    });
  }

  private retraction(tx: LedgerTransaction & { payload: { security_id: string } }, family: SecurityFamily): void {
    const security = this.security(tx, tx.payload.security_id, family);
    if (!security || !this.open(tx, security)) return;
    if (!security.outstanding.eq(security.issuedQuantity)) {
      this.violation("RETRACTION_OF_USED_LOT", "error", "Only an untouched lot can be retracted; reverse the later commands first", tx, security.identity.id);
    }
    this.changeOutstanding(security, security.outstanding.neg());
    security.retracted = true;
    this.close(tx, security, "RETRACTED");
    if (family === "EQUITY_COMPENSATION" && security.identity.stockPlanId !== null && security.origin === "GRANT") {
      const plan = this.state.plans.get(security.identity.stockPlanId);
      if (plan) plan.grantedGross = plan.grantedGross.sub(security.issuedQuantity);
    }
  }

  private acceptance(tx: LedgerTransaction & { payload: { security_id: string } }, family: SecurityFamily): void {
    const security = this.security(tx, tx.payload.security_id, family);
    if (security) this.open(tx, security);
  }

  private awardExercise(tx: LedgerTransactionOf<"TX_EQUITY_COMPENSATION_EXERCISE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "EQUITY_COMPENSATION");
    if (!security || !this.open(tx, security)) return;
    const id = security.identity.id;
    if (security.identity.subtype === "RSU") {
      this.violation("FAMILY_MISMATCH", "error", "RSUs are released, not exercised", tx, id);
      return;
    }
    const quantity = Dec.parse(p.quantity);
    const withheld = p.x_withheld_quantity ? Dec.parse(p.x_withheld_quantity) : Dec.ZERO;
    const date = tx.effectiveDate;
    const position = positionAt(this.state, security, date);
    const early = p.x_early_exercise === true || (security.earlyExercisable && quantity.gt(position.vestedOutstanding));
    if (!security.earlyExercisable && quantity.gt(position.vestedOutstanding)) {
      this.violation("EXCEEDS_VESTED_UNEXERCISED", "error", `Exercises ${quantity} with ${position.vestedOutstanding} vested and unexercised`, tx, id);
    } else if (quantity.gt(security.outstanding)) {
      this.violation("NEGATIVE_POSITION", "error", `Exercises ${quantity} of ${security.outstanding} outstanding`, tx, id);
    }
    if (security.expirationDate !== null && date > security.expirationDate) {
      this.violation("AFTER_EXPIRATION", "error", `Exercised after the expiration date ${security.expirationDate}`, tx, id);
    }
    const deadline = contractualDeadline(security);
    if (deadline !== null && date > deadline.date) {
      this.violation("AFTER_CONTRACTUAL_DEADLINE", "error", `Exercised after the contractual deadline ${deadline.date}`, tx, id);
    }
    if (security.executionStatus.startsWith("pending")) {
      this.violation("EXECUTION_PENDING", this.importTolerant(tx), "An execution-pending grant can't be exercised until it is marked executed", tx, id);
    }
    // Portions and lots are part of every exercise (the ledger rules): each resulting lot's tax portion, which Form 3921
    // reads, and the ISO and NSO lots consumed, frozen here. The schema requires both; these are the totals and their
    // consistency (I4).
    const portions = p.x_portions.map((portion) => ({ portion: portion.portion, quantity: Dec.parse(portion.quantity), securityId: portion.security_id }));
    const isoPortion = Dec.sum(portions.filter((x) => x.portion === "ISO").map((x) => x.quantity));
    const nsoPortion = p.x_portions.find((x) => x.portion === "NSO");
    const lots = { iso: Dec.parse(p.x_lots_consumed.iso), nso: Dec.parse(p.x_lots_consumed.nso) };
    if (!lots.iso.add(lots.nso).eq(quantity)) this.violation("LOTS_MISMATCH", "error", `The lots consumed (${lots.iso} ISO + ${lots.nso} NSO) aren't the quantity ${quantity}`, tx, id);
    if (security.identity.subtype !== "OPTION_ISO") {
      if (isoPortion.isPositive() || lots.iso.isPositive()) this.violation("ISO_PORTION_ON_NSO", "error", "Only an ISO grant has ISO lots or an ISO portion", tx, id);
    } else {
      const iso = isoDeadline(this.state, security);
      const afterIsoDeadline = iso !== null && iso.date !== null && date > iso.date;
      if (isoPortion.isPositive() && afterIsoDeadline) {
        this.violation("ISO_PORTION_AFTER_ISO_DEADLINE", this.importTolerant(tx), `ISO shares exercised after the ISO deadline ${iso!.date} are NSO`, tx, id);
      }
      if (isoPortion.gt(lots.iso)) {
        this.violation("ISO_PORTION_EXCEEDS_ISO_LOTS", "error", `An ISO portion of ${isoPortion} needs as many ISO lots; ${lots.iso} are consumed`, tx, id);
      }
      // ISO lots consumed become ISO shares unless they are withheld, or NSO because the ISO deadline has passed.
      let lateNso = Dec.ZERO;
      if (nsoPortion?.reason === "AFTER_ISO_DEADLINE") {
        lateNso = Dec.parse(nsoPortion.quantity);
        for (const source of iso?.sources ?? []) this.read("relies_on_deadline", source.commandId);
        if (!afterIsoDeadline) {
          this.violation("AFTER_ISO_DEADLINE_REASON_INVALID", this.importTolerant(tx), "Shares are NSO as exercised after the ISO deadline, but the exercise isn't after it", tx, id);
        }
      }
      const unexplained = lots.iso.sub(isoPortion).sub(lateNso).sub(withheld);
      if (unexplained.isPositive()) {
        this.violation(
          "ISO_LOTS_RECORDED_AS_NSO",
          this.importTolerant(tx),
          `${unexplained} ISO lots consumed are neither ISO shares, withheld, nor NSO after the ISO deadline (Form 3921 would miss them)`,
          tx,
          id,
        );
      }
      // Which lots: never more of either kind than the grant has, and ISO lots first unless the admin chose others
      // with a reason (the ledger rules). The availability is the engine's, so NSO lots an ISO grant doesn't have can't
      // be claimed to keep shares off Form 3921.
      const available = isoLotsAvailable(this.state, security, date);
      let lotChoiceFlagged = false;
      if (available.review) {
        this.violation("ISO_LOTS_UNVERIFIED", this.importTolerant(tx), "The grant's ISO lots need manual review: no FMV at grant here or on an earlier ISO grant", tx, id);
      } else {
        if (lots.iso.gt(available.iso)) {
          this.violation("ISO_LOTS_EXCEEDED", this.importTolerant(tx), `Consumes ${lots.iso} ISO lots with ${available.iso} available (the $100K test)`, tx, id);
        }
        if (lots.nso.gt(available.nso)) {
          this.violation("NSO_LOTS_EXCEEDED", this.importTolerant(tx), `Consumes ${lots.nso} NSO lots with ${available.nso} available: the rest are ISO lots`, tx, id);
        }
        const isoFirst = Dec.min(quantity, available.iso);
        if (lots.iso.lt(isoFirst) && p.x_lot_reason === undefined) {
          this.violation("LOT_CHOICE_NEEDS_REASON", this.importTolerant(tx), `Exercises use ISO lots first (${isoFirst} here); another choice needs its reason`, tx, id);
          lotChoiceFlagged = true;
        }
      }
      // An NSO portion of an ISO grant says why its shares aren't ISO: after the ISO deadline, over the $100K limit
      // (NSO lots), or the admin's lot choice (with the lot reason). A late or limit reason that doesn't hold is caught
      // above (AFTER_ISO_DEADLINE_REASON_INVALID, ISO_LOTS_RECORDED_AS_NSO).
      if (nsoPortion !== undefined) {
        if (nsoPortion.reason === undefined) {
          this.violation("NSO_PORTION_NEEDS_REASON", this.importTolerant(tx), "NSO shares of an ISO grant need their reason (after the ISO deadline, the $100K limit or a lot choice)", tx, id);
        } else if (nsoPortion.reason === "LOT_CHOICE" && p.x_lot_reason === undefined && !lotChoiceFlagged) {
          this.violation("LOT_CHOICE_NEEDS_REASON", this.importTolerant(tx), "A lot choice needs its reason", tx, id);
        }
      }
      // Earlier ISO grants share the limit: NSO lots consumed exist because of them, and the ISO lots consumed stay
      // available only while their vesting stays as it was.
      for (const grant of precedingIsoGrants(this.state, security)) {
        if (lots.nso.isPositive()) this.read("relies_on_terms", grant.issuance?.commandId ?? grant.identity.originCommandId);
        if (lots.iso.isPositive()) for (const [commandId, actor] of grant.actors) if (actor.shaper) this.read("relies_on_terms", commandId);
      }
    }
    const record: ExerciseRecord = {
      ...this.ref(tx),
      quantity,
      portions,
      lotsConsumed: lots,
      exercisePrice: p.x_exercise_price ? Rational.fromDec(p.x_exercise_price.amount) : security.exercisePrice,
      fmv: p.x_fmv ? Dec.parse(p.x_fmv.price_per_share.amount) : null,
      fmvValuationId: p.x_fmv?.valuation_id ?? tx.valuationId,
      earlyExercise: early,
      resultingSecurityIds: [...p.resulting_security_ids],
      withheld,
    };
    security.exercises.push(record);
    security.exercised = security.exercised.add(quantity);
    security.resultingSecurityIds.push(...p.resulting_security_ids);
    this.changeOutstanding(security, quantity.neg());
    this.poolEvent(tx, security, "SHARES_WITHHELD", withheld);
    this.closeIfEmpty(tx, security, "EXERCISED");
    this.links.push({
      kind: "EXERCISE",
      tx,
      sourceId: id,
      resulting: p.resulting_security_ids,
      resultingFamily: "STOCK",
      resultingOrigins: new Set(["EXERCISE"]),
      expected: quantity.sub(withheld),
      balanceId: null,
      expectedBalance: Dec.ZERO,
      portions,
    });
  }

  private cancellation(tx: LedgerTransactionOf<"TX_EQUITY_COMPENSATION_CANCELLATION"> | LedgerTransactionOf<"TX_WARRANT_CANCELLATION">, family: SecurityFamily): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, family);
    if (!security || !this.open(tx, security)) return;
    const id = security.identity.id;
    const quantity = Dec.parse(p.quantity);
    const position = positionAt(this.state, security, tx.effectiveDate);
    const explicit = "x_vesting_portion" in p ? p.x_vesting_portion : undefined;
    let unvested: Dec;
    if (explicit === "UNVESTED") {
      if (quantity.gt(position.unvestedOutstanding)) this.violation("CANCELLATION_EXCEEDS_UNVESTED", "error", "Cancels more than is unvested", tx, id);
      unvested = quantity;
    } else if (explicit === "VESTED") {
      if (quantity.gt(position.vestedOutstanding)) this.violation("CANCELLATION_EXCEEDS_VESTED", "error", "Cancels more than is vested", tx, id);
      unvested = Dec.ZERO;
    } else if (p.x_reason === "EXPIRED") {
      unvested = quantity.sub(Dec.min(quantity, position.vestedOutstanding));
    } else {
      unvested = Dec.min(quantity, position.unvestedOutstanding);
    }
    const vested = quantity.sub(unvested);
    security.cancelled = security.cancelled.add(quantity);
    security.cancelledUnvested = security.cancelledUnvested.add(unvested);
    security.cancelledVested = security.cancelledVested.add(vested);
    security.forfeited = security.forfeited.add(unvested);
    if (unvested.isPositive()) this.actOn(tx, security, true);
    if (p.x_reason === "EXPIRED") security.expired = security.expired.add(quantity);
    this.take(tx, security, quantity);
    if (family === "EQUITY_COMPENSATION") {
      this.poolEvent(tx, security, "CANCELLED_UNVESTED_AWARD", unvested);
      this.poolEvent(tx, security, "CANCELLED_VESTED_AWARD", vested);
    }
    this.moveToBalance(tx, security, p.balance_security_id, p.x_reason === "EXPIRED" ? "EXPIRED" : "CANCELLED", family);
  }

  private release(tx: LedgerTransactionOf<"TX_EQUITY_COMPENSATION_RELEASE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "EQUITY_COMPENSATION");
    if (!security || !this.open(tx, security)) return;
    if (security.identity.subtype !== "RSU") {
      this.violation("FAMILY_MISMATCH", "error", "Only RSUs are released", tx, security.identity.id);
      return;
    }
    const quantity = Dec.parse(p.quantity);
    const withheld = p.x_withheld_quantity ? Dec.parse(p.x_withheld_quantity) : Dec.ZERO;
    const position = positionAt(this.state, security, tx.effectiveDate);
    if (quantity.gt(position.vestedOutstanding)) {
      this.violation("EXCEEDS_VESTED_UNEXERCISED", "error", `Releases ${quantity} with ${position.vestedOutstanding} vested`, tx, security.identity.id);
    }
    security.released = security.released.add(quantity);
    security.resultingSecurityIds.push(...p.resulting_security_ids);
    this.changeOutstanding(security, quantity.neg());
    this.poolEvent(tx, security, "SHARES_WITHHELD", withheld);
    this.closeIfEmpty(tx, security, "EXERCISED");
    this.links.push({
      kind: "RELEASE",
      tx,
      sourceId: security.identity.id,
      resulting: p.resulting_security_ids,
      resultingFamily: "STOCK",
      resultingOrigins: new Set(["RELEASE"]),
      expected: quantity.sub(withheld),
      balanceId: null,
      expectedBalance: Dec.ZERO,
    });
  }

  private warrantExercise(tx: LedgerTransactionOf<"TX_WARRANT_EXERCISE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "WARRANT");
    if (!security || !this.open(tx, security)) return;
    const id = security.identity.id;
    const quantity = Dec.parse(p.x_quantity);
    const position = positionAt(this.state, security, tx.effectiveDate);
    if (quantity.gt(position.vestedOutstanding)) {
      this.violation("EXCEEDS_VESTED_UNEXERCISED", "error", `Exercises ${quantity} with ${position.vestedOutstanding} exercisable`, tx, id);
    }
    if (security.expirationDate !== null && tx.effectiveDate > security.expirationDate) {
      this.violation("AFTER_EXPIRATION", "error", `Exercised after the expiration date ${security.expirationDate}`, tx, id);
    }
    if (security.executionStatus.startsWith("pending")) {
      this.violation("EXECUTION_PENDING", this.importTolerant(tx), "An execution-pending warrant can't be exercised", tx, id);
    }
    security.exercised = security.exercised.add(quantity);
    security.resultingSecurityIds.push(...p.resulting_security_ids);
    this.changeOutstanding(security, quantity.neg());
    this.closeIfEmpty(tx, security, "EXERCISED");
    this.links.push({
      kind: "WARRANT_EXERCISE",
      tx,
      sourceId: id,
      resulting: p.resulting_security_ids,
      resultingFamily: "STOCK",
      resultingOrigins: new Set(["EXERCISE"]),
      expected: p.x_net_exercise === true ? { min: Dec.ZERO, max: quantity } : quantity,
      balanceId: null,
      expectedBalance: Dec.ZERO,
    });
  }

  private convertibleConversion(tx: LedgerTransactionOf<"TX_CONVERTIBLE_CONVERSION">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "CONVERTIBLE");
    if (!security || !this.open(tx, security)) return;
    const before = security.outstanding;
    const amount = p.quantity_converted !== undefined ? Dec.parse(p.quantity_converted) : before;
    if (amount.gt(before)) this.violation("NEGATIVE_POSITION", "error", `Converts ${amount} of ${before} outstanding`, tx, security.identity.id);
    if (amount.lt(before) && p.balance_security_id === undefined) {
      this.violation("CONVERSION_NOT_WHOLE", "error", "A conversion closes the whole convertible; the rest goes to a balance lot", tx, security.identity.id);
    }
    security.converted = security.converted.add(amount);
    security.resultingSecurityIds.push(...p.resulting_security_ids);
    this.changeOutstanding(security, amount.neg());
    this.links.push({
      kind: "CONVERTIBLE_CONVERSION",
      tx,
      sourceId: security.identity.id,
      resulting: p.resulting_security_ids,
      resultingFamily: "STOCK",
      resultingOrigins: new Set(["CONVERSION"]),
      expected: null,
      balanceId: null,
      expectedBalance: Dec.ZERO,
    });
    this.moveToBalance(tx, security, p.balance_security_id, "CONVERTED", "CONVERTIBLE");
  }

  private convertibleCancellation(tx: LedgerTransactionOf<"TX_CONVERTIBLE_CANCELLATION">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id, "CONVERTIBLE");
    if (!security || !this.open(tx, security)) return;
    const amount = Dec.parse(p.amount.amount);
    security.cancelled = security.cancelled.add(amount);
    this.take(tx, security, amount);
    this.moveToBalance(tx, security, p.balance_security_id, "CANCELLED", "CONVERTIBLE");
  }

  private acceleration(tx: LedgerTransactionOf<"TX_VESTING_ACCELERATION">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id);
    if (!security || !this.open(tx, security)) return;
    const quantity = Dec.parse(p.quantity);
    const alreadyApplied = p.x_explicit_already_applied === true;
    if (!alreadyApplied) {
      const gross = vestedAt(vestingInputsFor(this.state, security), tx.effectiveDate);
      const room = security.issuedQuantity.sub(security.cancelledUnvested).sub(security.repurchasedUnvested).sub(gross).clampZero();
      if (quantity.gt(room)) {
        this.violation("ACCELERATION_EXCEEDS_UNVESTED", "error", `Accelerates ${quantity} with ${room} unvested`, tx, security.identity.id);
      }
    }
    security.accelerations.push({ date: tx.effectiveDate, quantity, alreadyApplied, transactionId: tx.id });
  }

  private terminationRecord(tx: LedgerTransactionOf<"X_STAKEHOLDER_TERMINATION">): TerminationRecord {
    const p = tx.payload;
    return {
      ...this.ref(tx),
      type: p.termination_type,
      vestingStopDate: p.vesting_stop_date,
      disabilityAttestation: p.disability_attestation === true,
      relationshipBefore: p.relationship_before,
      relationshipAfter: p.relationship_after,
    };
  }

  private termination(tx: LedgerTransactionOf<"X_STAKEHOLDER_TERMINATION">): void {
    const p = tx.payload;
    const stakeholder = this.stakeholder(tx, p.stakeholder_id);
    if (!stakeholder) return;
    if (p.vesting_stop_date > p.termination_date) {
      this.violation("VESTING_STOP_AFTER_TERMINATION", "error", "The vesting stop can be earlier than the termination date, never later", tx);
    }
    stakeholder.terminations.push(this.terminationRecord(tx));
    // A leave that ended employment first sets the ISO test's employment end for every ISO grant of the holder.
    const leave = leaveEndingEmployment(stakeholder);
    if (leave !== null && leave.date < p.termination_date) this.read("relies_on_terms", leave.leave.commandId);
    const overrides = new Map((p.securities ?? []).map((entry) => [entry.security_id, entry]));
    for (const id of overrides.keys()) {
      const lot = this.state.securities.get(id);
      if (!lot || this.resolveStakeholder(lot.sourceStakeholderId) !== this.resolveStakeholder(p.stakeholder_id)) {
        this.violation("IDENTITY_MISMATCH", "error", "A per-security termination entry names another holder's lot", tx, id);
      }
    }
    // Vesting stops on every grant and restricted lot of the holder, closed ones included (an early-exercised option
    // keeps showing what vested); deadlines apply to the options still open.
    for (const security of this.state.securitiesByStakeholder.get(this.resolveStakeholder(p.stakeholder_id)) ?? []) {
      if (!security.issued || security.retracted) continue;
      if (security.issueDate !== null && security.issueDate > tx.effectiveDate) continue;
      const family = security.identity.family;
      if (family !== "EQUITY_COMPENSATION" && !(family === "STOCK" && hasVestingSchedule(security))) continue;
      this.readLot(security);
      // Restricted shares: the termination opens the company's repurchase window on the unvested ones.
      this.actOn(tx, security, true, family === "STOCK" ? "relies_on_deadline" : "relies_on_terms");
      const override = overrides.get(security.identity.id);
      const stop = override?.vesting_stop_date ?? p.vesting_stop_date;
      security.vestingStop = { ...this.ref(tx), date: stop };
      if (override?.cancelled_vesting_event_ids !== undefined) security.cancelledEventIds = new Set(override.cancelled_vesting_event_ids);
      else if (p.explicit_already_applied === true) security.cancelledEventIds = new Set();
      security.termination = { ...this.ref(tx), type: p.termination_type, disabilityAttestation: p.disability_attestation === true };
      if (family === "EQUITY_COMPENSATION" && security.identity.subtype !== "RSU" && security.closedBy === null) {
        const deadline = computeContractualDeadline(this.state, security, p.termination_date, p.termination_type);
        const source = windowSource(this.state, security, p.termination_type);
        this.read("relies_on_terms", source.terms?.commandId);
        if (deadline === null) {
          this.violation("NO_TERMINATION_WINDOW", "warning", `No exercise window for a ${p.termination_type} termination`, tx, security.identity.id);
          security.computedDeadline = null;
        } else {
          security.computedDeadline = { ...this.ref(tx), deadline, window: source.window };
          // Later commands on the option act within the window this termination opened (an expiry, an extension).
          this.actOn(tx, security, true, "relies_on_deadline");
        }
      }
    }
  }

  private modification(tx: LedgerTransactionOf<"X_SECURITY_MODIFICATION">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id);
    if (!security || !this.open(tx, security)) return;
    const id = security.identity.id;
    if (p.kind === "CONTRACTUAL_DEADLINE_EXTENSION") {
      if (security.identity.family !== "EQUITY_COMPENSATION" && security.identity.family !== "WARRANT") {
        this.violation("FAMILY_MISMATCH", "error", "Only options and warrants have an exercise deadline", tx, id);
        return;
      }
      if (security.expirationDate !== null && p.new_contractual_deadline > security.expirationDate) {
        this.violation("EXTENSION_AFTER_EXPIRATION", "error", "An extension can't go past the expiration date", tx, id);
      }
      const current = contractualDeadline(security);
      if (current !== null && p.new_contractual_deadline < current.date) {
        this.violation("EXTENSION_SHORTENS_DEADLINE", "error", `An extension can't shorten the deadline (${current.date})`, tx, id);
      }
      security.extendedDeadline = { ...this.ref(tx), deadline: p.new_contractual_deadline };
    } else {
      if (security.identity.family !== "STOCK") {
        this.violation("FAMILY_MISMATCH", "error", "Only shares have a repurchase deadline", tx, id);
        return;
      }
      security.lastRepurchaseDate = { ...this.ref(tx), deadline: p.last_repurchase_date };
    }
  }

  private openingBalance(tx: LedgerTransactionOf<"X_MIGRATION_OPENING_BALANCE">): void {
    const p = tx.payload;
    const security = this.security(tx, p.security_id);
    if (!security) return;
    if (tx.source !== "import") {
      this.violation("MIGRATION_FIELD_NOT_ALLOWED", "error", "An opening balance only comes from an import", tx, security.identity.id);
      return;
    }
    if (security.issued) {
      this.readLot(security);
      this.actOn(tx, security);
    } else {
      if (p.issuance === undefined) {
        this.checkOrigin(tx, security);
        security.issued = true;
        security.issueDate = tx.effectiveDate;
        security.issuance = this.ref(tx);
      } else {
        const issuanceType = {
          STOCK: "TX_STOCK_ISSUANCE",
          EQUITY_COMPENSATION: "TX_EQUITY_COMPENSATION_ISSUANCE",
          WARRANT: "TX_WARRANT_ISSUANCE",
          CONVERTIBLE: "TX_CONVERTIBLE_ISSUANCE",
        }[security.identity.family];
        let payload: unknown;
        try {
          payload = parsePayload(issuanceType as "TX_STOCK_ISSUANCE", p.issuance);
        } catch (error) {
          this.violation("OPENING_BALANCE_INVALID", "error", error instanceof Error ? error.message : String(error), tx, security.identity.id);
          return;
        }
        this.apply({ ...tx, type: issuanceType, payload } as LedgerTransaction);
      }
    }
    const outstanding = Dec.parse(p.outstanding);
    const exercised = p.exercised !== undefined ? Dec.parse(p.exercised) : Dec.ZERO;
    const cancelled = p.cancelled !== undefined ? Dec.parse(p.cancelled) : Dec.ZERO;
    const issued = p.issued !== undefined ? Dec.parse(p.issued) : outstanding.add(exercised).add(cancelled);
    if (!outstanding.add(exercised).add(cancelled).lte(issued)) {
      this.violation("OPENING_BALANCE_INVALID", "error", "Outstanding, exercised and cancelled exceed issued", tx, security.identity.id);
    }
    this.changeOutstanding(security, outstanding.sub(security.outstanding));
    security.issuedQuantity = issued;
    security.exercised = exercised;
    security.cancelled = cancelled;
    for (const key of ["released", "cancelledUnvested", "cancelledVested", "expired", "repurchased", "repurchasedUnvested", "repurchasedVested", "forfeited", "transferred", "converted", "reissued", "movedToBalance"] as const) {
      security[key] = Dec.ZERO;
    }
    // What isn't outstanding was consumed before the opening date; count it as vested consumption.
    security.cancelledVested = cancelled;
    if (security.vestingBase !== null) security.vestingBase = { ...security.vestingBase, quantity: issued };
    security.baseEventsCache = null;
    security.openingBalance = this.ref(tx);
    security.closedBy = null;
    security.status = "OUTSTANDING";
    if (!outstanding.isPositive()) this.close(tx, security, cancelled.isPositive() ? "CANCELLED" : "EXERCISED");
  }

  /**
   * A split (the ledger rules): open lots of the class, and awards and warrants delivering it, scale by the ratio
   * (fractions round down to the share unit, cash in lieu); exercise prices and the FMV at grant scale inversely;
   * vesting scales with the cumulative floor. Authorized shares and plan pools do not change: the split command
   * states those with explicit adjustments.
   */
  private split(tx: LedgerTransactionOf<"TX_STOCK_CLASS_SPLIT">): void {
    const stockClass = this.stockClass(tx, tx.payload.stock_class_id);
    if (!stockClass) return;
    const ratio = Rational.fromDec(tx.payload.split_ratio.numerator).div(Rational.fromDec(tx.payload.split_ratio.denominator));
    const unit = this.state.shareUnit;
    const classId = stockClass.ref.id;
    const scale = (value: Dec) => Rational.fromDec(value).mul(ratio).floorToUnit(unit);
    // Earlier splits of the class scaled the same lots and plan aggregates this one scales again.
    for (const prior of stockClass.splits) this.read("relies_on_terms", prior.commandId);
    for (const security of this.state.securities.values()) {
      const identity = security.identity;
      const delivered = identity.stockClassId ?? (identity.stockPlanId !== null ? (this.state.plans.get(identity.stockPlanId)?.ref.stockClassId ?? null) : null);
      if (delivered !== classId || identity.family === "CONVERTIBLE" || !security.issued) continue;
      // A closed lot isn't scaled, but it is part of the split's effect: reversing what closed it would reopen it and
      // change what the split scales. The plans' aggregates it scales below come from these lots too. The split is an
      // actor on every lot it read, so a later split depends on it through the lot as well.
      this.readLot(security);
      this.actOn(tx, security);
      if (security.closedBy !== null) continue;
      const consumedKeys = ["exercised", "released", "cancelled", "cancelledUnvested", "cancelledVested", "expired", "repurchased", "repurchasedUnvested", "repurchasedVested", "forfeited", "transferred", "converted", "reissued", "movedToBalance"] as const;
      for (const key of consumedKeys) security[key] = scale(security[key]);
      const newOutstanding = scale(security.outstanding);
      this.changeOutstanding(security, newOutstanding.sub(security.outstanding));
      const consumed = security.exercised.add(security.released).add(security.cancelled).add(security.repurchased).add(security.transferred).add(security.converted).add(security.reissued).add(security.movedToBalance);
      security.issuedQuantity = newOutstanding.add(consumed);
      if (security.exercisePrice !== null) security.exercisePrice = security.exercisePrice.div(ratio);
      if (security.basePrice !== null) security.basePrice = security.basePrice.div(ratio);
      if (security.fmvAtGrant !== null) security.fmvAtGrant = security.fmvAtGrant.div(ratio);
      if (security.vestingBase !== null) security.vestingBase = { ...security.vestingBase, splitRatio: security.vestingBase.splitRatio.mul(ratio) };
      security.accelerations = security.accelerations.map((a) => ({ ...a, quantity: scale(a.quantity) }));
      security.extraVestingEvents = security.extraVestingEvents.map((e) => ({ ...e, quantity: scale(e.quantity) }));
      security.baseEventsCache = null;
    }
    for (const plan of this.state.plans.values()) {
      if (plan.ref.stockClassId !== classId) continue;
      // It scales what was retired and returned, so it reads what decided them, and it becomes part of that record.
      for (const ref of [...plan.explicitReturnsBy, ...plan.retiredBy, ...plan.returnedBy]) this.read("relies_on_terms", ref.commandId);
      if (plan.retired.isPositive()) plan.retiredBy.push(this.ref(tx));
      if (plan.returned.isPositive()) plan.returnedBy.push(this.ref(tx));
      plan.retired = scale(plan.retired);
      plan.returned = scale(plan.returned);
      plan.explicitReturns = scale(plan.explicitReturns);
      plan.grantedGross = scale(plan.grantedGross);
    }
    stockClass.splits.push({ ...this.ref(tx), ratio });
    this.touchedClasses.add(classId);
  }

  // -------------------------------------------------------------------------
  // Date-level and final checks

  private endOfDate(date: IsoDate): void {
    for (const classId of this.touchedClasses) {
      const stockClass = this.state.classes.get(classId);
      const outstanding = this.classOutstanding.get(classId) ?? Dec.ZERO;
      if (stockClass?.authorized != null && outstanding.gt(stockClass.authorized)) {
        this.state.violations.push({
          code: "CLASS_OVER_AUTHORIZED",
          severity: "error",
          message: `${stockClass.ref.name}: ${outstanding} outstanding exceeds ${stockClass.authorized} authorized on ${date}`,
          effectiveDate: date,
        });
      }
    }
    this.touchedClasses.clear();
    if (this.issuerTouched && this.state.issuerAuthorized !== null && this.stockOutstanding.gt(this.state.issuerAuthorized)) {
      this.state.violations.push({
        code: "ISSUER_OVER_AUTHORIZED",
        severity: "error",
        message: `${this.stockOutstanding} shares outstanding exceed the ${this.state.issuerAuthorized} authorized on ${date}`,
        effectiveDate: date,
      });
    }
    this.issuerTouched = false;
    for (const [planId, check] of this.planChecks) {
      const plan = this.state.plans.get(planId)!;
      const available = plan.poolSize.sub(this.planOutstanding.get(planId) ?? Dec.ZERO).sub(plan.retired.sub(plan.explicitReturns));
      if (available.isNegative()) {
        this.violation(
          check.grant ? "EXCEEDS_PLAN_AVAILABLE" : "POOL_BELOW_USED",
          "error",
          `${plan.ref.name}: available to grant is ${available} on ${date}`,
          check.tx,
        );
      }
    }
    this.planChecks.clear();
  }

  /**
   * Lineage once every transaction has applied (I2, I4, I8). A derived lot belongs to exactly one transaction: listing
   * it twice, or from two transactions (as resulting or balance lot), would count its shares twice towards the
   * totals, so a second claim is an error and adds nothing.
   */
  private checkLinks(): void {
    const byId = new Map(this.derived.map((d) => [d.securityId, d]));
    const claimed = new Map<string, LedgerTransaction>();
    const claim = (link: Link, id: string): boolean => {
      const first = claimed.get(id);
      if (first !== undefined) {
        this.violation(
          "LOT_CLAIMED_TWICE",
          "error",
          first === link.tx ? `${link.tx.type} lists lot ${id} twice` : `Lot ${id} is claimed by ${first.type} ${first.id} and again by ${link.tx.type}`,
          link.tx,
          id,
        );
        return false;
      }
      claimed.set(id, link.tx);
      return true;
    };
    for (const link of this.links) {
      let total = Dec.ZERO;
      for (const id of link.resulting) {
        const lot = byId.get(id);
        if (!lot || !this.matches(link, lot, link.resultingFamily, link.resultingOrigins)) {
          this.violation("RESULTING_LOT_MISSING", "error", `Resulting lot ${id} isn't issued by the same command and date from ${link.sourceId}`, link.tx, link.sourceId);
          continue;
        }
        if (!claim(link, id)) continue;
        total = total.add(lot.quantity);
        if (link.kind === "WARRANT_EXERCISE" && lot.portion !== null) {
          this.violation("PORTION_MISMATCH", "error", "Warrant exercise shares have no ISO or NSO portion", link.tx, id);
        }
        if (link.kind === "TRANSFER" || link.kind === "REISSUANCE") {
          const source = this.state.securities.get(link.sourceId)!;
          const target = this.state.securities.get(id)!;
          if (target.identity.stockClassId !== source.identity.stockClassId) {
            this.violation("LINEAGE_MISMATCH", "error", "A transferred or reissued lot keeps its class", link.tx, id);
          }
        }
        if (link.kind === "EXERCISE" || link.kind === "RELEASE") {
          const source = this.state.securities.get(link.sourceId)!;
          const target = this.state.securities.get(id)!;
          if (target.identity.stakeholderId !== source.identity.stakeholderId) {
            this.violation("LINEAGE_MISMATCH", "error", "Exercise shares go to the option holder", link.tx, id);
          }
        }
      }
      if (link.expected !== null) {
        const ok = link.expected instanceof Dec ? total.eq(link.expected) : total.gte(link.expected.min) && total.lte(link.expected.max);
        if (!ok) {
          const code = link.kind === "TRANSFER" ? "TRANSFER_NOT_CONSERVED" : link.kind === "STOCK_CONVERSION" ? "CONVERSION_INCONSISTENT" : "RESULTING_QUANTITY_MISMATCH";
          this.violation(code, "error", `${link.tx.type}: resulting lots hold ${total}, expected ${link.expected instanceof Dec ? link.expected : `${link.expected.min}–${link.expected.max}`}`, link.tx, link.sourceId);
        }
      }
      if (link.portions !== undefined) {
        // One portion per resulting lot and one lot per portion (the schema), each holding the portion's quantity and
        // issued as that portion.
        const named = new Set(link.portions.map((x) => x.securityId));
        if (named.size !== link.portions.length || named.size !== link.resulting.length || link.resulting.some((id) => !named.has(id))) {
          this.violation("PORTION_MISMATCH", "error", "Each resulting lot has exactly one portion and each portion one resulting lot", link.tx, link.sourceId);
        }
        for (const portion of link.portions) {
          const lot = byId.get(portion.securityId);
          if (!link.resulting.includes(portion.securityId) || !lot || !lot.quantity.eq(portion.quantity)) {
            this.violation("PORTION_MISMATCH", "error", "Each exercise portion matches one resulting lot (ISO + NSO = quantity)", link.tx, link.sourceId);
          } else if (lot.portion !== portion.portion) {
            this.violation("PORTION_MISMATCH", "error", `Lot ${portion.securityId} is issued as ${lot.portion ?? "no portion"}, but the exercise makes it ${portion.portion}`, link.tx, portion.securityId);
          }
        }
        const portionTotal = Dec.sum(link.portions.map((x) => x.quantity));
        if (link.expected instanceof Dec && !portionTotal.eq(link.expected)) {
          this.violation("PORTION_MISMATCH", "error", "ISO + NSO portions don't add up to the exercise", link.tx, link.sourceId);
        }
      }
      if (link.balanceId !== null) {
        const lot = byId.get(link.balanceId);
        if (!lot || !this.matches(link, lot, link.resultingFamily, new Set(["BALANCE"]))) {
          this.violation("BALANCE_LOT_MISSING", "error", `Balance lot ${link.balanceId} isn't issued by the same command and date`, link.tx, link.sourceId);
        } else if (claim(link, link.balanceId)) {
          if (!lot.quantity.eq(link.expectedBalance)) {
            this.violation("TRANSFER_NOT_CONSERVED", "error", `The balance lot holds ${lot.quantity}, expected ${link.expectedBalance}`, link.tx, link.sourceId);
          }
        }
      }
    }
    for (const lot of this.derived) {
      if (claimed.has(lot.securityId)) continue;
      this.state.violations.push({
        code: "ORPHAN_DERIVED_LOT",
        severity: "error",
        message: `Lot ${lot.securityId} claims to come from ${lot.sourceId} by ${lot.origin}, but no such transaction lists it`,
        transactionId: lot.transactionId,
        securityId: lot.securityId,
        effectiveDate: lot.date,
      });
    }
  }

  private matches(link: Link, lot: Derived, family: SecurityFamily, origins: ReadonlySet<string>): boolean {
    return (
      lot.family === family &&
      origins.has(lot.origin) &&
      lot.sourceId === link.sourceId &&
      lot.commandId === link.tx.commandId &&
      lot.date === link.tx.effectiveDate
    );
  }
}

/** Replays decoded transactions as of a date (and, optionally, as known at a seq). */
export function replay(reference: EngineReference, transactions: readonly LedgerTransaction[], options: ReplayOptions): LedgerState {
  return new Replayer(reference, options).run(transactions);
}

/** Violations of a given severity. */
export function violationsOf(state: LedgerState, severity: ViolationSeverity = "error"): Violation[] {
  return state.violations.filter((violation) => violation.severity === severity);
}
