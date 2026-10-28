import type { IsoDate } from "./dates.ts";
import type { Dec } from "./decimal.ts";
import type { DependencyKind } from "./dependencies.ts";
import type { LedgerCommand, LedgerTransaction } from "./ledger.ts";
import type { CompensationType, IssuanceOrigin } from "./payloads.ts";
import type { PlanReturnRules } from "./plan-rules.ts";
import type { Rational } from "./rational.ts";
import type { ExecutionStatus, Exemption, OptionPortion, Period, Relationship, TerminationType, TerminationWindow } from "./schemas.ts";
import type { Acceleration, PauseInterval, VestingDefinition, VestingScheduleEvent } from "./vesting.ts";

/**
 * The replayed state of an org's ledger as of a date and as known at a seq (the ledger rules). Everything here is derived
 * from reference rows and transactions; nothing is stored. The Worker caches it per (org, seq, head hash,
 * ENGINE_VERSION) and treats it as read-only.
 */

export type SecurityFamily = "STOCK" | "EQUITY_COMPENSATION" | "WARRANT" | "CONVERTIBLE";
export type SecuritySubtype = "COMMON" | "PREFERRED" | "OPTION_ISO" | "OPTION_NSO" | "RSU" | "SAR" | "WARRANT" | "SAFE" | "NOTE";
/** `SecurityStatus` in the API contract. A reissued lot shows as CANCELLED (the enum has no REISSUED). */
export type SecurityStatus = "OUTSTANDING" | "EXERCISED" | "CANCELLED" | "EXPIRED" | "REPURCHASED" | "TRANSFERRED" | "CONVERTED" | "RETRACTED";

// ---------------------------------------------------------------------------
// Reference rows (identity and descriptive data the engine needs; migrations/0001)

/** A `securities` row: thin identity, written once by the command that creates the lot. */
export interface SecurityIdentity {
  id: string;
  family: SecurityFamily;
  subtype: SecuritySubtype;
  stakeholderId: string;
  /** STOCK: the class held. Awards and warrants: the class delivered on exercise. */
  stockClassId: string | null;
  stockPlanId: string | null;
  displayId: string;
  originCommandId: string;
  parentSecurityId: string | null;
}

export interface StockClassRef {
  id: string;
  name: string;
  classType: "COMMON" | "PREFERRED";
}

export interface StockPlanRef {
  id: string;
  name: string;
  stockClassId: string;
}

export interface StakeholderRef {
  id: string;
  /** The current relationship (a termination's payload keeps the one before it). */
  relationship: Relationship;
  kind?: "individual" | "institution";
  countryOfResidence?: string | null;
  taxStatus?: "us" | "non_us" | "unknown";
  /**
   * ISO grants from a parent or subsidiary, entered by an admin and attested once. They share the optionee's $100K
   * limit and take their place in grant order.
   */
  outsideIsoGrants?: readonly OutsideIsoGrantRef[];
}

/** An outside ISO grant as entered: decimals are canonical strings, validated when the replay starts. */
export interface OutsideIsoGrantRef {
  /** A stable id: grants on the same date are ordered by id. */
  id: string;
  grantDate: IsoDate;
  /** FMV per share on the grant date; must be greater than 0. */
  fmvPerShare: string;
  /** Shares of the grant that first become exercisable in each calendar year. */
  firstExercisable: readonly { year: number; shares: string }[];
}

export interface VestingTermsRef {
  id: string;
  definition: VestingDefinition;
  definitionSha256: string;
}

export interface EngineReference {
  orgId: string;
  /** `orgs.share_unit`: '1' = whole shares. Vesting and conversion round down to it. */
  shareUnit: string;
  securities: readonly SecurityIdentity[];
  stockClasses: readonly StockClassRef[];
  stockPlans: readonly StockPlanRef[];
  stakeholders: readonly StakeholderRef[];
  vestingTerms: readonly VestingTermsRef[];
  /** Needed for dependencies and reversal checks; replay uses them only to snap `asKnownAt` to a command boundary. */
  commands?: readonly LedgerCommand[];
}

// ---------------------------------------------------------------------------
// Violations

export type ViolationSeverity = "error" | "warning";

/**
 * A broken invariant or rule found by replay. `error`s are hard blocks for a write (the ledger rules); `warning`s are shown
 * and, for imported history, reviewed. Codes are stable (the API maps them to messages, the API contract).
 */
export interface Violation {
  code: string;
  severity: ViolationSeverity;
  message: string;
  transactionId?: string;
  securityId?: string;
  effectiveDate?: IsoDate;
}

// ---------------------------------------------------------------------------
// Replayed state

export interface TxRef {
  transactionId: string;
  commandId: string;
  date: IsoDate;
}

export interface ExerciseRecord extends TxRef {
  quantity: Dec;
  portions: { portion: OptionPortion; quantity: Dec; securityId: string }[];
  /** ISO and NSO lots consumed (frozen at exercise; ISO first by default). */
  lotsConsumed: { iso: Dec; nso: Dec };
  exercisePrice: Rational | null;
  fmv: Dec | null;
  fmvValuationId: string | null;
  earlyExercise: boolean;
  resultingSecurityIds: string[];
  withheld: Dec;
}

/** What a later command acting on a lot relies on when an earlier command acted on it (the ledger rules). */
export interface LotActor {
  kind: DependencyKind;
  /** It shaped the lot's vesting (and so its ISO lots by year): a stop, an acceleration, an unvested cancellation… */
  shaper: boolean;
}

export interface TerminationApplied extends TxRef {
  type: TerminationType;
  disabilityAttestation: boolean;
}

export interface SecurityState {
  identity: SecurityIdentity;
  /** The immutable holder on the securities row, before a known stakeholder merge canonicalizes it. */
  sourceStakeholderId: string;
  /** An issuance (or an opening balance standing in for one) has been applied. */
  issued: boolean;
  issueDate: IsoDate | null;
  issuance: TxRef | null;
  origin: IssuanceOrigin | "GRANT" | null;
  sourceSecurityId: string | null;
  /** Shares (stock, awards, warrants) or principal (convertibles). Split-adjusted. */
  issuedQuantity: Dec;
  outstanding: Dec;
  exercised: Dec;
  released: Dec;
  cancelled: Dec;
  cancelledUnvested: Dec;
  cancelledVested: Dec;
  expired: Dec;
  repurchased: Dec;
  repurchasedUnvested: Dec;
  repurchasedVested: Dec;
  /** Unvested awards cancelled plus unvested shares repurchased at a price of zero. */
  forfeited: Dec;
  transferred: Dec;
  converted: Dec;
  reissued: Dec;
  /** A partial cancellation, repurchase, transfer or conversion moves the rest to a balance lot (OCF's pattern). */
  movedToBalance: Dec;
  retracted: boolean;
  status: SecurityStatus;
  closedBy: (TxRef & { type: string }) | null;
  currency: string | null;
  sharePrice: Dec | null;
  /** Options and warrants: split-adjusted and repriced. */
  exercisePrice: Rational | null;
  /** The exercise price in the issuance payload (Rule 701 counts securities at their price at grant). */
  exercisePriceAtGrant: Rational | null;
  basePrice: Rational | null;
  compensationType: CompensationType | null;
  expirationDate: IsoDate | null;
  terminationWindows: TerminationWindow[];
  earlyExercisable: boolean;
  /** FMV per share at grant (the payload's snapshot), split-adjusted: the ISO $100K test uses it. */
  fmvAtGrant: Rational | null;
  exemption: Exemption | null;
  capitalContribution: Dec;
  vestingTermsId: string | null;
  vestingStartDate: IsoDate | null;
  /** The quantity the vesting definition was issued for and the cumulative split ratio since. */
  vestingBase: { quantity: Dec; splitRatio: Rational } | null;
  accelerations: Acceleration[];
  extraVestingEvents: VestingScheduleEvent[];
  pauses: PauseInterval[];
  vestingStop: TxRef | null;
  cancelledEventIds: ReadonlySet<string> | null;
  executionStatus: ExecutionStatus;
  executionStatusSetBy: TxRef | null;
  termination: TerminationApplied | null;
  /** The contractual deadline set by the termination (window for its type, capped at expiration). */
  computedDeadline: (TxRef & { deadline: IsoDate; window: TerminationWindow | null }) | null;
  /** A recorded extension: it replaces the computed deadline from its date (the ledger rules). */
  extendedDeadline: (TxRef & { deadline: IsoDate }) | null;
  lastRepurchaseDate: (TxRef & { deadline: IsoDate }) | null;
  repurchaseRight: { pricePerShare: Dec | null; window: Period | null } | null;
  exercises: ExerciseRecord[];
  resultingSecurityIds: string[];
  openingBalance: TxRef | null;
  lastActivity: IsoDate | null;
  /**
   * The earlier commands that acted on the lot, other than the one that issued it. A later command acting on the
   * lot relies on each of them (its quantities, deadlines and vesting are what they left), so they can only be
   * reversed after it.
   */
  actors: Map<string, LotActor>;
  boardApprovalDate: IsoDate | null;
  /** Imported without a board approval date. */
  boardApprovalNotRecordedInPulley: boolean;
  /** Migrated: debt cancelled for the lot, as recorded (converted SAFEs). */
  debtCancelled: Dec | null;
  /** Migrated legend snapshots (new lots name legends by id in their payload). */
  legends: { legendId: string; name: string; text: string }[];
  /** Memo of the base vesting events (cleared when the quantity or split ratio changes). */
  baseEventsCache: VestingScheduleEvent[] | null;
}

export interface ClassTerms {
  votesPerShare: Dec;
  excludeFromFullyDiluted: boolean;
  seniority: number | null;
  liquidationPreferenceMultiple: Dec | null;
  participation: string | null;
  participationCapMultiple: Dec | null;
  antiDilution: string | null;
  notRecordedInPulley: string[];
}

export interface ClassState {
  ref: StockClassRef;
  authorized: Dec | null;
  authorizedSetBy: TxRef | null;
  conversionRatio: Rational;
  conversionRatioSetBy: TxRef | null;
  convertsToClassId: string | null;
  terms: ClassTerms;
  termsSetBy: TxRef | null;
  splits: (TxRef & { ratio: Rational })[];
}

export interface PlanTermsState extends TxRef {
  rules: PlanReturnRules;
  defaultTerminationWindows: TerminationWindow[];
  defaultRepurchaseWindow: Period | null;
  status: "active" | "terminated";
  pourOverPlanId: string | null;
}

export interface PlanState {
  ref: StockPlanRef;
  poolSize: Dec;
  poolSetBy: TxRef | null;
  /** Every X_STOCK_PLAN_TERMS applied, in effective order; the last one is in force. */
  termsHistory: PlanTermsState[];
  /** Shares retired under the rules (gross of explicit returns). */
  retired: Dec;
  /**
   * What decided each retirement: the transactions whose pool events retired shares and the plan terms whose rule
   * said RETIRE (splits that scaled `retired` too). An explicit return consumes what they retired.
   */
  retiredBy: TxRef[];
  /** The same for shares returned under the rules; a split scales both. */
  returnedBy: TxRef[];
  /** Shares returned to the pool under the rules (cancellations, repurchases, withholding). */
  returned: Dec;
  explicitReturns: Dec;
  /** The explicit returns to the pool, each a plan-level fact a split scales (the ledger dependency rules). */
  explicitReturnsBy: TxRef[];
  /** Awards granted from the plan (not transfers or balance lots), gross of later events. */
  grantedGross: Dec;
}

export interface TerminationRecord extends TxRef {
  type: TerminationType;
  vestingStopDate: IsoDate;
  disabilityAttestation: boolean;
  relationshipBefore: Relationship;
  relationshipAfter: Relationship;
}

export interface LeaveRecord extends TxRef {
  startDate: IsoDate;
  endDate: IsoDate | null;
  returnGuaranteed: boolean;
}

/** An outside ISO grant, validated. */
export interface OutsideIsoGrant {
  id: string;
  grantDate: IsoDate;
  fmv: Rational;
  firstExercisable: Map<number, Dec>;
}

export interface StakeholderState {
  ref: StakeholderRef;
  terminations: TerminationRecord[];
  leaves: LeaveRecord[];
  outsideIsoGrants: OutsideIsoGrant[];
  /** Known terminations effective after `asOf` (their `relationshipBefore` is the relationship on `asOf`). */
  laterTerminations: TerminationRecord[];
}

export interface LedgerState {
  orgId: string;
  asOf: IsoDate;
  asKnownAt: number | null;
  /** The highest seq the replay considered (≤ asKnownAt). */
  ledgerSeq: number;
  shareUnit: Dec;
  securities: Map<string, SecurityState>;
  /** The same lots by holder (identity never changes), so per-holder work doesn't scan the org. */
  securitiesByStakeholder: Map<string, SecurityState[]>;
  classes: Map<string, ClassState>;
  plans: Map<string, PlanState>;
  stakeholders: Map<string, StakeholderState>;
  /** Duplicate record id to its surviving identity. Identity facts apply to every as-of date once known. */
  stakeholderAliases: Map<string, string>;
  /** The ledger command that established each alias, used to make later identity-sensitive commands depend on it. */
  stakeholderMergeCommands: Map<string, string>;
  vestingTerms: Map<string, VestingTermsRef>;
  issuerAuthorized: Dec | null;
  /** Transactions applied, in replay order (corrected payloads in place). */
  applied: LedgerTransaction[];
  /** Transactions voided by a known X_REVERSAL. */
  reversedTransactionIds: Set<string>;
  /** Lots whose opening balance is dated after `asOf`: "history before <date> not migrated". */
  pendingOpeningBalances: Map<string, IsoDate>;
  /**
   * For each command, the earlier commands whose facts its transactions read while being applied, with the edge kind
   * (`command_dependencies`; dependencies.commandDependencies). Only commands with a lower seq count.
   */
  commandReads: Map<string, Map<string, DependencyKind>>;
  violations: Violation[];
}
