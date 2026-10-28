import { engine } from "#shared";
import { isSelfDealing } from "../../access/self-dealing.ts";
import { ApiError, notFound } from "../../http.ts";
import { stateAt } from "../../read/ledger.ts";
import type { ApiViolation } from "../errors.ts";
import { uuidv7 } from "../ids.ts";
import type { CommandContext, CommandPlan, DocumentUse } from "../types.ts";

/** A new, empty plan for a command; its id is the first generated id (the diff hash normalizes it). */
export function newPlan(ctx: CommandContext, name: string): CommandPlan {
  const commandId = uuidv7(ctx.now);
  return {
    name,
    commandId,
    transactions: [],
    securities: [],
    vestingTerms: [],
    reversesCommandId: null,
    note: null,
    violations: [],
    warnings: [],
    documents: [],
    workflow: [],
    audit: { summary: name, targetType: "command", targetId: commandId },
    created: { securityIds: [], scheduledTerminationIds: [], vestingTermsIds: [] },
    extraChanges: [],
    reviewedInputs: [],
    generatedIds: [commandId],
  };
}

/** An id generated for this call, recorded for the diff hash. */
export function generateId(ctx: CommandContext, plan: CommandPlan): string {
  const id = uuidv7(ctx.now);
  plan.generatedIds.push(id);
  return id;
}

/** The ledger replayed as of the org's today: what a builder reads to plan its transactions. */
export function currentState(ctx: CommandContext, asOf: string = ctx.today): engine.LedgerState {
  return stateAt(ctx.ledger, { asOf, today: ctx.today });
}

export function securityOr404(state: engine.LedgerState, securityId: string): engine.SecurityState {
  const security = state.securities.get(securityId);
  if (!security) throw notFound("Security not found");
  return security;
}

export interface StakeholderRow {
  id: string;
  display_name: string;
  relationship: engine.Relationship;
  version: number;
  archived_at: number | null;
  merged_into_id: string | null;
}

export async function stakeholderOr404(ctx: CommandContext, stakeholderId: string): Promise<StakeholderRow> {
  const row = await ctx.db.prepare(
    "SELECT id, display_name, relationship, version, archived_at, merged_into_id FROM stakeholders WHERE org_id = ? AND id = ?",
  ).bind(ctx.org.id, stakeholderId).first<StakeholderRow>();
  if (!row || row.archived_at !== null || row.merged_into_id !== null) throw notFound("Stakeholder not found");
  return row;
}

/**
 * The self-dealing block: no administrator records a command on a stakeholder linked to their console e-mail
 * or by an explicit administrator link. On-demand system work acts for no person.
 */
export async function assertNotSelfDealing(ctx: CommandContext, stakeholderIds: readonly string[]): Promise<void> {
  if (ctx.actor.kind !== "user" || ctx.actor.email === null) return;
  if (await isSelfDealing(ctx.db, ctx.org.id, ctx.actor.email, [...new Set(stakeholderIds)])) {
    throw new ApiError("self_dealing", "An administrator cannot record a transaction on their own holdings");
  }
}

/** The typed confirmation (the product rules): exactly the expected text, ignoring surrounding spaces. */
export function assertConfirmation(confirmation: string, expected: readonly string[]): void {
  const typed = confirmation.trim();
  if (!expected.some((value) => value === typed)) {
    throw new ApiError("validation_failed", `Type ${expected[0]} to confirm`, [{ path: "confirmation", message: `Type ${expected[0]} to confirm` }]);
  }
}

export function money(amount: string, currency: string): { amount: string; currency: string } {
  return { amount, currency };
}

/** The next free `PREFIX-n` display id (never reused, even after a reversal: the identity rows stay). */
export function nextDisplayId(ctx: CommandContext, prefix: string, taken: ReadonlySet<string> = new Set()): string {
  let max = 0;
  const pattern = new RegExp(`^${prefix.replace(/[^A-Za-z0-9]/g, "")}-(\\d+)$`);
  for (const security of ctx.ledger.reference.securities) {
    const match = pattern.exec(security.displayId);
    if (match) max = Math.max(max, Number(match[1]));
  }
  for (const id of taken) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${max + 1}`;
}

export function displayIdTaken(ctx: CommandContext, displayId: string): boolean {
  return ctx.ledger.reference.securities.some((security) => security.displayId === displayId);
}

/** The holder a document link ends at, for the document checks: a security's holder or the stakeholder itself. */
export function holderOfTarget(state: engine.LedgerState, extraSecurities: readonly engine.SecurityIdentity[]) {
  return (target: DocumentUse["target"]): string | null => {
    if (target.type === "stakeholder") return target.id;
    if (target.type === "security") {
      return state.securities.get(target.id)?.identity.stakeholderId ?? extraSecurities.find((s) => s.id === target.id)?.stakeholderId ?? null;
    }
    return null;
  };
}

/** API exit windows ({period, unit, reason}) in the payload's OCF form; a fractional period is a 400. */
export function windowsToOcf(windows: readonly { period: string; unit: "DAYS" | "MONTHS" | "QUARTERS" | "YEARS"; reason: "VOLUNTARY" | "INVOLUNTARY" | "WITH_CAUSE" | "DEATH" | "DISABILITY" | "RETIREMENT" }[], path: string): engine.TerminationWindow[] {
  return windows.map((window, index) => {
    try {
      return engine.terminationWindowFromApi(window);
    } catch {
      throw new ApiError("validation_failed", "An exit window is a whole number of days, months, quarters or years", [
        { path: `${path}.${index}.period`, message: "Use a whole number" },
      ]);
    }
  });
}

/** An API period ({period, unit}) in the payload's OCF form. */
export function periodToOcf(period: { period: string; unit: "DAYS" | "MONTHS" | "QUARTERS" | "YEARS" } | null, path: string): engine.Period | null {
  if (period === null) return null;
  const value = engine.Dec.from(period.period);
  if (!value.isInteger() || value.gt(1200)) {
    throw new ApiError("validation_failed", "A period is a whole number", [{ path: `${path}.period`, message: "Use a whole number" }]);
  }
  const count = Number(value.mantissa);
  return period.unit === "QUARTERS" ? { period: count * 3, period_type: "MONTHS" } : { period: count, period_type: period.unit };
}

/** Option and warrant commands act on ISO options, NSO options and warrants. */
export function isOptionOrWarrant(security: engine.SecurityState): boolean {
  const { family, subtype } = security.identity;
  return family === "WARRANT" || (family === "EQUITY_COMPENSATION" && (subtype === "OPTION_ISO" || subtype === "OPTION_NSO"));
}

export function violation(code: string, message: string, extra: Partial<ApiViolation> = {}): ApiViolation {
  return { code, message, ...extra };
}

/** The org's only common class is the default class of an FMV lookup. */
export function commonClassId(ctx: CommandContext): string | null {
  const commons = ctx.ledger.reference.stockClasses.filter((c) => c.classType === "COMMON");
  return commons.length === 1 ? commons[0]!.id : null;
}
