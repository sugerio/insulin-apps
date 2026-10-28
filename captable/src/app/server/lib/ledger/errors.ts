import type { ApiErrorBody, ApiErrorCode } from "#shared";
import { ApiError } from "../http.ts";

/** A 422 violation as the API contractshapes it. */
export interface ApiViolation {
  code: string;
  message: string;
  securityId?: string;
  effectiveDate?: string;
  /** Present when a read-write administrator may override the block with the listed evidence. */
  override?: { role: "admin_rw"; requires: string[] };
}

export interface ApiWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Dependent {
  commandId: string;
  type: string;
  createdAt: number;
}

export type ConflictReason = "stale_version" | "stale_ledger" | "idempotency_key_reused" | "state_changed" | "dependents_exist" | "migrated_history";

interface LedgerErrorExtra {
  reason?: string;
  issues?: { path: string; message: string }[];
  violations?: ApiViolation[];
  warnings?: ApiWarning[];
  dependents?: Dependent[];
}

/**
 * An ApiError whose envelope also carries the command-specific parts of the API contract: warnings to acknowledge, the
 * dependents of a refused reversal, and violations with their security, date and override. `app.onError` renders any
 * ApiError through `toResponse`, so this subclass needs no change to the platform's error handling.
 */
export class LedgerError extends ApiError {
  override name = "LedgerError";

  constructor(code: ApiErrorCode, message: string, readonly extra: LedgerErrorExtra = {}) {
    super(code, message, extra.issues, { reason: extra.reason, violations: extra.violations });
  }

  override toResponse(headers?: HeadersInit): Response {
    const body: ApiErrorBody = { error: { code: this.code, message: this.message } };
    if (this.extra.reason) body.error.reason = this.extra.reason;
    if (this.extra.issues?.length) body.error.issues = this.extra.issues;
    if (this.extra.violations?.length) body.error.violations = this.extra.violations;
    if (this.extra.warnings?.length) body.error.warnings = this.extra.warnings;
    if (this.extra.dependents?.length) body.error.dependents = this.extra.dependents;
    return Response.json(body, { status: this.status, headers });
  }
}

export function invariantViolation(violations: ApiViolation[]): LedgerError {
  const first = violations[0];
  const message = violations.length === 1 && first ? first.message : `${violations.length} rules block this command`;
  return new LedgerError("invariant_violation", message, { violations });
}

export function warningsUnacknowledged(warnings: ApiWarning[]): LedgerError {
  return new LedgerError("warnings_unacknowledged", "Acknowledge the warnings and send the command again", { warnings });
}

export function conflict(reason: ConflictReason, message: string, dependents?: Dependent[]): LedgerError {
  return new LedgerError("conflict", message, { reason, dependents });
}

export function validationFailed(path: string, message: string): LedgerError {
  return new LedgerError("validation_failed", message, { issues: [{ path, message }] });
}

/** What a failed D1 batch means, decided by the RAISE text and the extended result code, never by changes counts. */
export type BatchFailure =
  | { kind: "idempotency" }
  | { kind: "conflict"; reason: ConflictReason; message: string }
  | { kind: "violation"; code: string; message: string }
  | { kind: "unavailable"; message: string };

/** RAISE(ABORT) texts of the guard triggers a command batch can hit, with the contractual answer of each. */
const TRIGGER_MESSAGES: { text: string; failure: BatchFailure }[] = [
  { text: "stale ledger", failure: { kind: "conflict", reason: "stale_ledger", message: "The ledger moved since you reviewed this; review it again" } },
  { text: "reverse the dependent commands first", failure: { kind: "conflict", reason: "dependents_exist", message: "Reverse the dependent commands first" } },
  { text: "migrated history is not reversible", failure: { kind: "conflict", reason: "migrated_history", message: "Migrated history can't be reversed in the app" } },
  { text: "a reversal cannot be reversed", failure: { kind: "conflict", reason: "state_changed", message: "A reversal can't be reversed" } },
  { text: "cannot build on a reversed command", failure: { kind: "conflict", reason: "state_changed", message: "The command this depends on was reversed; review it again" } },
  { text: "stale version", failure: { kind: "conflict", reason: "stale_version", message: "Something changed since you loaded it; reload and try again" } },
  {
    text: "illegal scheduled termination transition",
    failure: { kind: "conflict", reason: "state_changed", message: "The scheduled termination was applied or cancelled meanwhile; reload it" },
  },
  {
    text: "illegal payment instruction transition",
    failure: { kind: "conflict", reason: "state_changed", message: "The payment instruction changed meanwhile; reload it" },
  },
  {
    text: "a holder-visible document cannot be linked to a second holder",
    failure: { kind: "violation", code: "DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER", message: "A document visible to one holder can't be linked to another holder" },
  },
  // A guarded statement's precondition no longer held because a concurrent write got there first.
  { text: "batch assertion failed", failure: { kind: "conflict", reason: "state_changed", message: "Something changed while this was being recorded; review it again" } },
];

/** Tables whose UNIQUE or PRIMARY KEY a concurrent command batch can collide on (the loser rolls back whole). */
const RACE_TABLES = /(?:UNIQUE|PRIMARY KEY) constraint failed: (securities|command_dependencies|transactions|commands|scheduled_terminations|stakeholder_emails|document_links|payment_instructions|valuations|valuation_prices|valuation_events|expiry_runs)\./;

/**
 * Maps a failed batch by its SQLite extended result code first and its text only
 * within that code: a guard trigger's RAISE text counts only with SQLITE_CONSTRAINT_TRIGGER, a collision only with
 * SQLITE_CONSTRAINT_UNIQUE or _PRIMARYKEY, so an unrelated failure that happens to mention "stale ledger" is not a
 * contractual 409. D1's reset errors carry no SQLite code and map by their text: the CPU-limit reset to
 * 503, the deferred-constraint reset to 409. Everything else returns null and is rethrown as a 500, logged with its
 * extended code only.
 */
export function classifyBatchFailure(error: unknown): BatchFailure | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = extendedCode(error);
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    if (/(?:UNIQUE|PRIMARY KEY) constraint failed: idempotency_keys\./.test(message)) return { kind: "idempotency" };
    if (RACE_TABLES.test(message)) {
      return { kind: "conflict", reason: "state_changed", message: "Something changed while this was being recorded; review it again" };
    }
    return null;
  }
  if (code === "SQLITE_CONSTRAINT_TRIGGER") {
    for (const entry of TRIGGER_MESSAGES) if (message.includes(entry.text)) return entry.failure;
    return null;
  }
  if (code === null && message.includes("exceeded its CPU time limit and was reset")) {
    return { kind: "unavailable", message: "The database was busy and reset; nothing was written. Try again" };
  }
  // D1's reset after a deferred foreign-key violation at commit means nothing was written, so return 409.
  if (code === null && message.includes("was reset and rolled back") && message.includes("constraints were violated")) {
    return { kind: "conflict", reason: "state_changed", message: "Something changed while this was being recorded; review it again" };
  }
  return null;
}

/** The extended result code of a D1 error, for logs (never the SQL or the values). */
export function extendedCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return /extended: ([A-Z_]+)/.exec(message)?.[1] ?? /(SQLITE_[A-Z_]+)/.exec(message)?.[1] ?? previewCode(message);
}

/**
 * The preview's D1 (`src/local-d1.ts`, over node:sqlite) reports a failure as `D1_ERROR: <SQLite message>` without
 * the extended result code. Only SQLite's exact wording at the start of that message is recognized: its UNIQUE
 * constraint text, or one of the guard triggers' RAISE texts above, so a lost race is the same 409 there as on D1.
 */
function previewCode(message: string): string | null {
  const text = /^D1_ERROR: ([^]*)$/.exec(message)?.[1];
  if (text === undefined) return null;
  if (/^(?:UNIQUE|PRIMARY KEY) constraint failed: /.test(text)) return "SQLITE_CONSTRAINT_UNIQUE";
  if (TRIGGER_MESSAGES.some((entry) => text.startsWith(entry.text))) return "SQLITE_CONSTRAINT_TRIGGER";
  return null;
}
