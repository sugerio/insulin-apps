import { engine } from "#shared";
import { stateAt } from "../read/ledger.ts";
import { computeChanges, diffSha256, effectSha256 } from "./diff.ts";
import type { ApiViolation, ApiWarning } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import type { Change, CommandContext, CommandPlan } from "./types.ts";

/**
 * The engine step of a command (command processing step 4): give the planned transactions their seqs and chain links,
 * replay the whole ledger with them at their effective dates (which catches back-dated conflicts), and report what
 * the command broke, what needs acknowledging, what it depends on and what it changes.
 */
export interface Evaluation {
  plan: CommandPlan;
  transactions: engine.LedgerTransaction[];
  rows: engine.TransactionRow[];
  firstSeq: number;
  lastSeq: number;
  /** The head after the command commits. */
  headHash: string | null;
  before: engine.LedgerState | null;
  after: engine.LedgerState | null;
  violations: ApiViolation[];
  warnings: ApiWarning[];
  dependencies: engine.DependencyEdge[];
  changes: Change[];
  diffSha256: string;
  /** What the command itself does (`diff.ts` `effectSha256`): a bulk flow's test for asking again (the API contract). */
  effectSha256: string;
}

function maxDate(dates: Iterable<string>, floor: string): string {
  let max = floor;
  for (const date of dates) if (date > max) max = date;
  return max;
}

function apiViolation(violation: engine.Violation, codeMap: Record<string, string> | undefined): ApiViolation {
  const result: ApiViolation = { code: codeMap?.[violation.code] ?? violation.code, message: violation.message };
  if (violation.securityId !== undefined) result.securityId = violation.securityId;
  if (violation.effectiveDate !== undefined) result.effectiveDate = violation.effectiveDate;
  return result;
}

function dedupe<T extends { code: string }>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const violationKey = (v: ApiViolation) => `${v.code}|${v.securityId ?? ""}`;
const warningKey = (w: ApiWarning) => `${w.code}|${String(w.details?.securityId ?? "")}`;

function mergeTotals(state: engine.LedgerState, stakeholderId: string) {
  const holder = engine.computeMetrics(state).holders.find((row) => row.stakeholderId === stakeholderId);
  return {
    securityCount: (state.securitiesByStakeholder.get(stakeholderId) ?? []).filter((security) => security.issued).length,
    issuedAndOutstanding: holder?.stockOutstanding.toString() ?? "0",
    fullyDiluted: holder?.fullyDiluted.toString() ?? "0",
    capitalContribution: holder?.capitalContribution.toString() ?? "0",
  };
}

function economicChangeLabel(change: Change, displayId: string | undefined): string {
  const subject = displayId ?? change.id;
  if (change.entity === "deadline") return `${subject}'s exercise or repurchase deadline would change`;
  if (change.entity === "vesting") return `${subject}'s vesting would change`;
  if (change.entity === "security") return `${subject}'s lot economics would change`;
  if (change.entity === "stakeholder") return `The stakeholder's termination, leave or relationship facts would change`;
  if (change.entity === "stock_plan" || change.entity === "pool") return `Stock plan ${subject} would change`;
  return `${change.entity} ${subject} would change`;
}

function transactionSecurityIds(transaction: engine.LedgerTransaction): string[] {
  const payload = transaction.payload as Record<string, unknown>;
  const ids = new Set<string>();
  if (transaction.securityId !== null) ids.add(transaction.securityId);
  for (const key of ["security_id", "x_source_security_id"] as const) {
    const value = payload[key];
    if (typeof value === "string") ids.add(value);
  }
  const resulting = payload.resulting_security_ids;
  if (Array.isArray(resulting)) for (const value of resulting) if (typeof value === "string") ids.add(value);
  return [...ids];
}

export function commandAction(command: engine.LedgerCommand | undefined, transactions: readonly engine.LedgerTransaction[]): string {
  if (transactions.some((transaction) => transaction.type === "X_STAKEHOLDER_TERMINATION")) return "termination";
  if (transactions.some((transaction) => transaction.type === "TX_VESTING_START")) return "vesting";
  const labels: Record<string, string> = {
    "cancel-security": "cancellation",
    "exercise-option": "exercise",
    "expire-securities": "expiration",
    "extend-exercise-deadline": "exercise-window extension",
    "grant-equity-compensation": "grant",
    "record-leave-of-absence": "leave of absence",
    "reverse-command": "reversal",
    "terminate-stakeholder": "termination",
  };
  return command === undefined ? "ledger command" : labels[command.type] ?? command.type.replaceAll("-", " ");
}

function actionDate(action: string, transactions: readonly engine.LedgerTransaction[]): string | null {
  const matching = action === "termination"
    ? transactions.find((transaction) => transaction.type === "X_STAKEHOLDER_TERMINATION")
    : action === "vesting"
      ? transactions.find((transaction) => transaction.type === "TX_VESTING_START")
      : transactions[0];
  return matching?.effectiveDate ?? transactions[0]?.effectiveDate ?? null;
}

function lotsSubject(ids: readonly string[], displayIds: ReadonlyMap<string, string>): string {
  const labels = [...new Set(ids.map((id) => displayIds.get(id)).filter((label): label is string => label !== undefined))].sort();
  if (labels.length === 0) return "The command's";
  if (labels.length === 1) return `${labels[0]}'s`;
  return `${labels.join(", ")} lots'`;
}

/** Turns the verifier's internal command ids into the lot/date language an administrator can investigate. */
function dependencyBlockerLabel(
  item: engine.Violation,
  state: engine.LedgerState,
  commands: readonly engine.LedgerCommand[],
  transactions: readonly engine.LedgerTransaction[],
): { id: string; label: string } {
  const ids = [...item.message.matchAll(/[0-9a-f-]{36}/g)].map((match) => match[0]);
  const commandId = ids[0];
  const dependsOnCommandId = ids[1];
  if (commandId === undefined || dependsOnCommandId === undefined) {
    return { id: commandId ?? "dependency-edge", label: "A ledger command is missing a required dependency edge" };
  }
  const byId = new Map(commands.map((command) => [command.id, command]));
  const transactionsFor = (id: string) => transactions.filter((transaction) => transaction.commandId === id);
  const commandTransactions = transactionsFor(commandId);
  const dependencyTransactions = transactionsFor(dependsOnCommandId);
  const displayIds = new Map(Array.from(state.securities.values(), (security) => [security.identity.id, security.identity.displayId] as const));
  const commandLots = commandTransactions.flatMap(transactionSecurityIds);
  const dependencyLots = dependencyTransactions.flatMap(transactionSecurityIds);
  const commonLots = commandLots.filter((id) => dependencyLots.includes(id));
  const dependentAction = commandAction(byId.get(commandId), commandTransactions);
  const dependencyAction = commandAction(byId.get(dependsOnCommandId), dependencyTransactions);
  const commandDate = actionDate(dependentAction, commandTransactions);
  const dependencyDate = actionDate(dependencyAction, dependencyTransactions);
  const left = `${lotsSubject(commonLots.length > 0 ? commonLots : commandLots, displayIds)} ${dependentAction}${commandDate ? ` (${commandDate})` : ""}`;
  const right = `${lotsSubject(commonLots.length > 0 ? commonLots : dependencyLots, displayIds)} ${dependencyAction}${dependencyDate ? ` (${dependencyDate})` : ""}`;
  return { id: commandId, label: `${left} depends on ${right}` };
}

function isoSnapshot(state: engine.LedgerState, security: engine.SecurityState): Record<string, unknown> | null {
  if (security.identity.subtype !== "OPTION_ISO") return null;
  const split = engine.isoSplit(state, security.identity.stakeholderId).find((row) => row.securityId === security.identity.id);
  if (!split) return null;
  return {
    iso: split.iso.toString(), nso: split.nso.toString(), unclassified: split.unclassified.toString(), review: split.review,
    years: split.years.map((year) => ({
      year: year.year, iso: year.iso.toString(), nso: year.nso.toString(), unclassified: year.unclassified.toString(),
    })),
  };
}

export function evaluatePlan(ctx: CommandContext, plan: CommandPlan): Evaluation {
  const ledger = ctx.ledger;
  const firstSeq = ledger.seq + 1;
  const violations: ApiViolation[] = [...plan.violations];
  const warnings: ApiWarning[] = [...plan.warnings];
  const transactions: engine.LedgerTransaction[] = [];
  let decodeFailed = false;
  plan.transactions.forEach((draft, index) => {
    const id = draft.id ?? uuidv7(ctx.now);
    if (draft.id === undefined) plan.generatedIds.push(id);
    const payload = draft.payload;
    try {
      transactions.push(engine.decodeTransaction({
        id,
        seq: firstSeq + index,
        commandId: plan.commandId,
        type: draft.type,
        effectiveDate: draft.effectiveDate,
        payload,
        payloadVersion: draft.payloadVersion ?? engine.PAYLOAD_VERSION,
        ...engine.denormalizedColumns(payload),
        reversesTxId: draft.type === "X_REVERSAL" ? (payload.reverses_tx_id as string) : null,
        supersedesTxId: draft.type === "X_CORRECTION" ? (payload.supersedes_tx_id as string) : null,
        source: ctx.source,
      }));
    } catch (error) {
      // A payload the engine's schema refuses can't reach the chain (the ledger rules): the command is blocked.
      decodeFailed = true;
      const code = error instanceof engine.EngineError ? error.code : "PAYLOAD_INVALID";
      violations.push({ code: plan.codeMap?.[code] ?? code, message: error instanceof Error ? error.message : String(error) });
    }
  });
  const lastSeq = firstSeq + plan.transactions.length - 1;
  const rows: engine.TransactionRow[] = [];
  let prev = ledger.headHash ?? ledger.genesisHash;
  if (!decodeFailed) {
    plan.transactions.forEach((draft, index) => {
      const row = engine.buildTransactionRow(transactions[index]!, {
        orgId: ctx.org.id,
        recordedAt: ctx.now,
        recordedBy: ctx.actor.userId,
        pulleyRef: draft.pulleyRef ?? null,
      }, prev);
      rows.push(row);
      prev = row.chain_hash;
    });
  }
  const dates = [...ledger.transactions.map((tx) => tx.effectiveDate), ...plan.transactions.map((tx) => tx.effectiveDate)];
  const asOf = maxDate(dates, ctx.today);
  let before: engine.LedgerState | null = null;
  let after: engine.LedgerState | null = null;
  let dependencies: engine.DependencyEdge[] = [];
  let changes: Change[] = [...plan.extraChanges];
  if (!decodeFailed) {
    before = stateAt(ledger, { asOf, today: ctx.today });
    const replayCommands: engine.LedgerCommand[] = [
      ...ledger.reference.commands,
      {
        id: plan.commandId,
        type: plan.name,
        actorKind: ctx.actor.kind,
        reversesCommandId: plan.reversesCommandId,
        firstSeq,
        lastSeq,
        declaredTxCount: plan.transactions.length,
        createdAt: ctx.now,
      },
    ];
    const reference: engine.EngineReference = {
      ...ledger.reference,
      securities: [...ledger.reference.securities, ...plan.securities],
      vestingTerms: [...ledger.reference.vestingTerms, ...plan.vestingTerms],
      commands: replayCommands,
    };
    after = engine.replay(reference, [...ledger.transactions, ...transactions], { asOf, today: ctx.today });
    for (const violation of engine.violationsIntroduced(before.violations, after.violations)) violations.push(apiViolation(violation, plan.codeMap));
    const known = new Set(before.violations.map(engine.violationKey));
    for (const violation of after.violations) {
      if (violation.severity !== "warning" || known.has(engine.violationKey(violation))) continue;
      if (plan.ignoredEngineWarnings?.includes(violation.code)) continue;
      const details: Record<string, unknown> = {};
      if (violation.securityId !== undefined) details.securityId = violation.securityId;
      if (violation.effectiveDate !== undefined) details.effectiveDate = violation.effectiveDate;
      warnings.push({ code: plan.codeMap?.[violation.code] ?? violation.code, message: violation.message, details });
    }
    const edges = new Map<string, engine.DependencyEdge>();
    for (const edge of engine.commandDependencies(after, plan.commandId)) {
      const existing = edges.get(edge.dependsOnCommandId);
      if (!existing || engine.DEPENDENCY_STRENGTH[edge.kind] > engine.DEPENDENCY_STRENGTH[existing.kind]) edges.set(edge.dependsOnCommandId, edge);
    }
    dependencies = [...edges.values()].sort((a, b) => (a.dependsOnCommandId < b.dependsOnCommandId ? -1 : 1));
    const replayChanges = computeChanges(ctx.org.id, before, after, new Set(plan.created.securityIds));
    if (plan.mergeNeutrality !== undefined) {
      for (const [id, security] of after.securities) {
        const prior = before.securities.get(id);
        if (!prior || security.identity.subtype !== "OPTION_ISO") continue;
        const beforeIso = isoSnapshot(before, prior);
        const afterIso = isoSnapshot(after, security);
        if (engine.canonicalJson(beforeIso) === engine.canonicalJson(afterIso)) continue;
        if (!replayChanges.some((change) => change.entity === "security" && change.id === id)) {
          replayChanges.push({ entity: "security", id, before: { isoSplit: beforeIso }, after: { isoSplit: afterIso } });
        }
      }
    }
    changes = [...replayChanges, ...plan.extraChanges];
    if (plan.mergeNeutrality !== undefined && plan.stakeholderMerge !== undefined) {
      const preview = plan.stakeholderMerge;
      preview.holdings.survivorAfter = mergeTotals(after, preview.survivor.id);
      const displayIds = new Map(Array.from(after.securities.values(), (security) => [security.identity.id, security.identity.displayId] as const));
      for (const change of replayChanges) {
        const label = economicChangeLabel(change, displayIds.get(change.id));
        preview.blockingItems.push({ type: "economic_change", id: change.id, label });
        violations.push({
          code: "STAKEHOLDER_MERGE_NOT_NEUTRAL",
          message: label,
          ...(["security", "deadline", "vesting"].includes(change.entity) ? { securityId: change.id } : {}),
        });
      }
      const missing = engine.missingDependencyEdges(after, replayCommands, [
        ...plan.mergeNeutrality.recordedDependencies,
        ...dependencies,
      ]);
      for (const item of missing) {
        const blocker = dependencyBlockerLabel(item, after, replayCommands, [...ledger.transactions, ...transactions]);
        preview.blockingItems.push({ type: "dependency_edge", ...blocker });
        violations.push({ code: item.code, message: blocker.label });
      }
      for (const item of violations) {
        if (preview.blockingItems.some((blocker) => blocker.label === item.message)) continue;
        preview.blockingItems.push({ type: "ledger_violation", id: item.securityId ?? plan.commandId, label: item.message });
      }
    }
  }
  return {
    plan,
    transactions,
    rows,
    firstSeq,
    lastSeq,
    headHash: rows.length > 0 ? rows[rows.length - 1]!.chain_hash : ledger.headHash,
    before,
    after,
    violations: dedupe(violations, violationKey),
    warnings: dedupe(warnings, warningKey),
    dependencies,
    changes,
    diffSha256: diffSha256(changes, plan.transactions, plan.generatedIds, plan.reviewedInputs),
    effectSha256: effectSha256(changes, plan.transactions, plan.generatedIds, plan.reviewedInputs),
  };
}
