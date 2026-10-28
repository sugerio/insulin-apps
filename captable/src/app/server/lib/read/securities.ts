import { api, engine } from "#shared";
import { notFound } from "../http.ts";
import { loadEdges, REVERSIBLE_COMMAND_TYPES } from "../ledger/commands/reverse.ts";
import { dec, echo, ratio, type ReadContext } from "./context.ts";

/**
 * Security views for admins (the API contract): identity, the terms from the issuance payload and later facts, the
 * replayed numbers comparable field by field with Pulley's, deadlines, certificate and provenance.
 */

export interface SecurityLookups {
  names: Map<string, string>;
  certificates: Map<string, { id: string; number: string; status: "ISSUED" | "CANCELLED" | "VOID"; documentId: string | null }>;
  txById: Map<string, engine.LedgerTransaction>;
  /** Terms later facts set, per security: one pass over the applied transactions instead of one per security. */
  laterTerms: Map<string, Record<string, unknown>>;
}

function laterTerms(state: engine.LedgerState): Map<string, Record<string, unknown>> {
  const terms = new Map<string, Record<string, unknown>>();
  const set = (securityId: string, key: string, value: unknown) => {
    const entry = terms.get(securityId) ?? {};
    entry[key] = value;
    terms.set(securityId, entry);
  };
  for (const tx of state.applied) {
    if (tx.type === "TX_CONVERTIBLE_CONVERSION" && tx.payload.x_conversion_price) set(tx.payload.security_id, "x_conversion_price", tx.payload.x_conversion_price);
    else if (tx.type === "X_EQUITY_COMPENSATION_REPRICING") set(tx.payload.security_id, "exercise_price", tx.payload.new_exercise_price);
    else if (tx.type === "X_SECURITY_MODIFICATION" && tx.payload.kind === "CONTRACTUAL_DEADLINE_EXTENSION") set(tx.payload.security_id, "x_contractual_deadline_extension", tx.payload.new_contractual_deadline);
    else if (tx.type === "X_SECURITY_MODIFICATION" && tx.payload.kind === "REPURCHASE_DEADLINE") set(tx.payload.security_id, "x_last_repurchase_date", tx.payload.last_repurchase_date);
  }
  return terms;
}

export async function securityLookups(ctx: ReadContext, state: engine.LedgerState): Promise<SecurityLookups> {
  const [stakeholders, certificates] = await ctx.db.batch([
    ctx.db.prepare("SELECT id, display_name FROM stakeholders WHERE org_id = ?").bind(ctx.org.id),
    ctx.db.prepare("SELECT id, security_id, certificate_number, status, document_id, created_at FROM certificates WHERE org_id = ? ORDER BY created_at, id").bind(ctx.org.id),
  ]);
  const names = new Map(((stakeholders?.results ?? []) as { id: string; display_name: string }[]).map((row) => [row.id, row.display_name]));
  const certificateMap: SecurityLookups["certificates"] = new Map();
  for (const row of (certificates?.results ?? []) as { id: string; security_id: string; certificate_number: string; status: "ISSUED" | "CANCELLED" | "VOID"; document_id: string | null }[]) {
    const existing = certificateMap.get(row.security_id);
    // The issued certificate wins; otherwise the latest one stays as history.
    if (!existing || existing.status !== "ISSUED") {
      certificateMap.set(row.security_id, { id: row.id, number: row.certificate_number, status: row.status, documentId: row.document_id });
    }
  }
  return { names, certificates: certificateMap, txById: new Map(ctx.ledger.transactions.map((tx) => [tx.id, tx])), laterTerms: laterTerms(state) };
}

/** The issuance payload, merged with what later facts set: a conversion's price, a repricing, an extension. */
export function securityTerms(security: engine.SecurityState, lookups: SecurityLookups): Record<string, unknown> {
  const issuance = security.issuance ? lookups.txById.get(security.issuance.transactionId) : undefined;
  const terms: Record<string, unknown> = issuance ? { ...(issuance.payload as Record<string, unknown>) } : {};
  if (issuance?.type === "X_MIGRATION_OPENING_BALANCE") {
    const opening = issuance.payload as { issuance?: Record<string, unknown> };
    if (opening.issuance) Object.assign(terms, opening.issuance);
  }
  Object.assign(terms, lookups.laterTerms.get(security.identity.id) ?? {});
  return terms;
}

/** One security's terms, for a single-security view that doesn't need the list lookups. */
export function securityTermsOf(ctx: ReadContext, state: engine.LedgerState, security: engine.SecurityState): Record<string, unknown> {
  const issuance = security.issuance ? ctx.ledger.transactions.find((tx) => tx.id === security.issuance!.transactionId) : undefined;
  const txById = new Map(issuance ? [[issuance.id, issuance]] : []);
  return securityTerms(security, { names: new Map(), certificates: new Map(), txById, laterTerms: laterTerms(state) });
}

/** The legends on a lot: migrated snapshots, then those a new lot names by id in its payload (`x_legend_ids`). */
export async function legendsOf(ctx: ReadContext, security: engine.SecurityState, terms: Record<string, unknown>): Promise<{ id: string; name: string }[]> {
  const legends: { id: string; name: string }[] = security.legends.map((legend) => ({ id: legend.legendId, name: legend.name }));
  const legendIds = (terms.x_legend_ids as string[] | undefined) ?? [];
  if (legendIds.length > 0) {
    const { results } = await ctx.db.prepare("SELECT id, name FROM legends WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))")
      .bind(ctx.org.id, JSON.stringify(legendIds)).all<{ id: string; name: string }>();
    legends.push(...results);
  }
  return legends;
}

/** Imported, by the legacy `provenance.importedFromPulley` rule: a source id or imported issuance. */
export function importedFromPulley(ctx: ReadContext, security: engine.SecurityState): boolean {
  const meta = ctx.ledger.securityMeta.get(security.identity.id);
  const issuance = security.issuance ? ctx.ledger.transactions.find((tx) => tx.id === security.issuance!.transactionId) : undefined;
  return meta?.pulleyId != null || issuance?.source === "import";
}

function provenance(ctx: ReadContext, security: engine.SecurityState, lookups: SecurityLookups): api.Security["provenance"] {
  const meta = ctx.ledger.securityMeta.get(security.identity.id);
  const issuance = security.issuance ? lookups.txById.get(security.issuance.transactionId) : undefined;
  const evidence = (issuance?.payload as { x_evidence?: { file: string; sha256: string }[] } | undefined)?.x_evidence?.[0];
  const imported = meta?.pulleyId != null || issuance?.source === "import";
  return {
    importedFromPulley: imported,
    sourceFile: evidence?.file ?? null,
    sourceSha256: evidence?.sha256 ?? null,
    pulleyId: ctx.viewer.fullAccess ? (meta?.pulleyId ?? null) : null,
  };
}

export function numbersJson(numbers: engine.SecurityNumbers, state: engine.LedgerState): api.SecurityNumbers {
  return {
    asOf: state.asOf,
    asKnownAt: state.asKnownAt ?? state.ledgerSeq,
    issued: dec(numbers.issued),
    outstanding: dec(numbers.outstanding),
    fullyDiluted: dec(numbers.fullyDiluted),
    vested: dec(numbers.vested),
    unvested: dec(numbers.unvested),
    vestedOutstanding: dec(numbers.vestedOutstanding),
    exercised: dec(numbers.exercised),
    exercisable: dec(numbers.exercisable),
    cancelled: dec(numbers.cancelled),
    repurchased: dec(numbers.repurchased),
    repurchaseable: dec(numbers.repurchaseable),
    forfeited: dec(numbers.forfeited),
    fullyDilutedPct: ratio(numbers.fullyDilutedPct),
    outstandingPct: ratio(numbers.outstandingPct),
  };
}

export function securityJson(
  ctx: ReadContext,
  state: engine.LedgerState,
  security: engine.SecurityState,
  numbers: engine.SecurityNumbers,
  lookups: SecurityLookups,
): api.Security {
  const terms = securityTerms(security, lookups);
  const exemption = terms.x_exemption as { federal?: api.Security["exemption"]["federal"]; country?: string; state?: string } | undefined;
  const contractual = numbers.contractualDeadline;
  const iso = numbers.isoDeadline;
  return {
    id: security.identity.id,
    family: security.identity.family,
    subtype: security.identity.subtype,
    stakeholderId: security.identity.stakeholderId,
    stakeholderName: lookups.names.get(security.identity.stakeholderId) ?? "",
    stockClassId: security.identity.stockClassId,
    stockPlanId: security.identity.stockPlanId,
    displayId: security.identity.displayId,
    issueDate: security.issueDate ?? state.asOf,
    status: security.status,
    executionStatus: security.executionStatus,
    parentSecurityId: security.identity.parentSecurityId,
    originCommandId: security.identity.originCommandId,
    terms,
    deadlines: contractual === null && iso === null ? null : { contractual, iso, reason: numbers.deadlineReason },
    exemption: { federal: exemption?.federal ?? null, country: exemption?.country ?? null, state: exemption?.state ?? null },
    boardApprovalDate: numbers.boardApprovalDate,
    boardApprovalNotRecordedInPulley: numbers.boardApprovalNotRecordedInPulley,
    numbers: numbersJson(numbers, state),
    certificate: lookups.certificates.get(security.identity.id) ?? null,
    provenance: provenance(ctx, security, lookups),
  };
}

/** Every issued security as of the view, with its numbers (a whole list; the SPA filters). */
export function securityList(ctx: ReadContext, state: engine.LedgerState, lookups: SecurityLookups, family?: engine.SecurityFamily): api.Security[] {
  const metrics = engine.computeMetrics(state);
  const byId = new Map(metrics.securities.map((numbers) => [numbers.securityId, numbers]));
  const items: api.Security[] = [];
  for (const security of state.securities.values()) {
    if (!security.issued || (family !== undefined && security.identity.family !== family)) continue;
    const numbers = byId.get(security.identity.id);
    if (numbers) items.push(securityJson(ctx, state, security, numbers, lookups));
  }
  return items.sort((a, b) => naturalCompare(a.displayId, b.displayId));
}

export function naturalCompare(a: string, b: string): number {
  const pa = /^(.*?)(\d+)$/.exec(a);
  const pb = /^(.*?)(\d+)$/.exec(b);
  if (pa && pb && pa[1] === pb[1]) return Number(pa[2]) - Number(pb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function issuedSecurityOr404(state: engine.LedgerState, securityId: string): engine.SecurityState {
  const security = state.securities.get(securityId);
  if (!security || !security.issued) throw notFound("Security not found");
  return security;
}

export async function securityDetail(ctx: ReadContext, state: engine.LedgerState, securityId: string): Promise<api.SecurityDetail> {
  const security = issuedSecurityOr404(state, securityId);
  const lookups = await securityLookups(ctx, state);
  const metrics = engine.computeMetrics(state);
  const numbers = metrics.securities.find((n) => n.securityId === securityId)!;
  const base = securityJson(ctx, state, security, numbers, lookups);
  const parent = security.identity.parentSecurityId !== null ? state.securities.get(security.identity.parentSecurityId) : undefined;
  const children = ctx.ledger.reference.securities
    .filter((child) => child.parentSecurityId === securityId || security.resultingSecurityIds.includes(child.id))
    .map((child) => {
      const acting = ctx.ledger.transactions.find((tx) => tx.commandId === child.originCommandId && tx.securityId === securityId);
      return { id: child.id, displayId: child.displayId, transactionType: acting?.type ?? "TX_STOCK_ISSUANCE" };
    });
  const legends = await legendsOf(ctx, security, base.terms);
  // "Reverse last transaction": the newest command on the lot (its issuance or any later actor) that reverse-command
  // would accept now, by the reversal's own rules (a current-release reversible type, not migrated, not a reversal or reversed,
  // nothing standing on it). Edges are read only for the candidates, so a migrated lot costs no query.
  const candidates = [...new Set([security.identity.originCommandId, ...security.actors.keys()])]
    .map((commandId) => ctx.ledger.commands.get(commandId))
    .filter((command): command is NonNullable<typeof command> =>
      command !== undefined && REVERSIBLE_COMMAND_TYPES.has(command.type) && command.actorKind !== "import" && command.reversesCommandId === null);
  let lastReversible: { id: string; firstSeq: number } | null = null;
  if (candidates.length > 0) {
    const edges = await loadEdges(ctx.db, ctx.org.id, candidates.map((command) => command.id));
    for (const command of candidates) {
      if (engine.reversalRefusal(command.id, edges, ctx.ledger.reference.commands) !== null) continue;
      if (lastReversible === null || command.firstSeq > lastReversible.firstSeq) lastReversible = command;
    }
  }
  const { results: documents } = await ctx.db.prepare(
    `SELECT DISTINCT d.id, d.filename, d.kind, d.created_at FROM document_links l JOIN documents d ON d.org_id = l.org_id AND d.id = l.document_id
     WHERE l.org_id = ? AND l.security_id = ? AND l.revoked_at IS NULL AND d.archived_at IS NULL ORDER BY d.created_at, d.id`,
  ).bind(ctx.org.id, securityId).all<{ id: string; filename: string; kind: api.DocumentRef["kind"] }>();
  return api.securityDetailSchema.parse({
    ...base,
    ...echo(ctx, state),
    lineage: { parent: parent ? { id: parent.identity.id, displayId: parent.identity.displayId } : null, children },
    legends,
    documents: documents.map((row) => ({ id: row.id, filename: row.filename, kind: row.kind })),
    lastReversibleCommandId: lastReversible?.id ?? null,
  });
}

export function securityVesting(ctx: ReadContext, state: engine.LedgerState, securityId: string): api.SecurityVesting {
  const security = issuedSecurityOr404(state, securityId);
  const position = engine.positionAt(state, security, state.asOf);
  const timeline = engine.securityVestingTimeline(state, security);
  return api.securityVestingSchema.parse({
    ...echo(ctx, state),
    securityId,
    quantity: dec(security.issuedQuantity),
    vested: dec(position.vested),
    unvested: dec(position.unvestedOutstanding),
    vestingStartDate: security.vestingStartDate ?? (engine.hasVestingSchedule(security) ? security.issueDate : null),
    vestingStopDate: security.vestingStop?.date ?? null,
    events: timeline.map((event) => ({
      date: event.date,
      quantity: dec(event.quantity),
      cumulative: dec(event.cumulative),
      state: event.state,
      kind: event.kind,
      source: event.source,
    })),
  });
}

const DESCRIBE: Partial<Record<engine.TransactionTypeCode, string>> = {
  TX_STOCK_ISSUANCE: "Shares issued",
  TX_EQUITY_COMPENSATION_ISSUANCE: "Granted",
  TX_EQUITY_COMPENSATION_EXERCISE: "Exercised",
  TX_EQUITY_COMPENSATION_CANCELLATION: "Cancelled",
  TX_WARRANT_ISSUANCE: "Warrant issued",
  TX_WARRANT_CANCELLATION: "Warrant cancelled",
  TX_CONVERTIBLE_ISSUANCE: "Convertible issued",
  TX_CONVERTIBLE_CONVERSION: "Converted",
  TX_VESTING_START: "Vesting started",
  TX_VESTING_ACCELERATION: "Vesting accelerated",
  X_EXECUTION_STATUS: "Execution status recorded",
  X_SECURITY_MODIFICATION: "Terms modified",
  X_STAKEHOLDER_TERMINATION: "Holder terminated",
  X_MIGRATION_OPENING_BALANCE: "Opening balance",
  X_REVERSAL: "Reversed",
};

function describe(tx: engine.LedgerTransaction): string {
  const quantity = tx.quantity !== null ? ` (${tx.quantity})` : "";
  return `${DESCRIBE[tx.type] ?? tx.type}${quantity}`;
}

/** The lot's and its lineage's transactions, oldest first with reversals, signature acts and document events (the API contract). */
export async function securityTimeline(ctx: ReadContext, state: engine.LedgerState, securityId: string, actorLabel: (commandId: string) => Promise<string | null>): Promise<api.TimelineEntry[]> {
  const security = state.securities.get(securityId) ?? null;
  const identity = ctx.ledger.reference.securities.find((s) => s.id === securityId);
  if (!identity || security === null) throw notFound("Security not found");
  const lineage = new Set([securityId, ...ctx.ledger.reference.securities.filter((s) => s.parentSecurityId === securityId).map((s) => s.id)]);
  if (identity.parentSecurityId !== null) lineage.add(identity.parentSecurityId);
  const entries: api.TimelineEntry[] = [];
  const reversalOf = new Map<string, engine.LedgerTransaction>();
  for (const tx of ctx.ledger.transactions) if (tx.type === "X_REVERSAL") reversalOf.set(tx.payload.reverses_tx_id, tx);
  for (const tx of ctx.ledger.transactions) {
    const target = (tx.payload as { security_id?: string }).security_id ?? null;
    if (tx.type === "X_REVERSAL" || target === null || !lineage.has(target)) continue;
    const meta = ctx.ledger.txMeta.get(tx.id);
    entries.push({
      kind: "transaction",
      at: meta?.recordedAt ?? 0,
      effectiveDate: tx.effectiveDate,
      transactionId: tx.id,
      commandId: tx.commandId,
      type: tx.type,
      summary: describe(tx),
      actor: await actorLabel(tx.commandId),
      note: ctx.ledger.commands.get(tx.commandId)?.note ?? null,
      securityId: target,
    });
    const reversal = reversalOf.get(tx.id);
    if (reversal) {
      const reversalMeta = ctx.ledger.txMeta.get(reversal.id);
      entries.push({
        kind: "reversal",
        at: reversalMeta?.recordedAt ?? 0,
        effectiveDate: reversal.effectiveDate,
        transactionId: reversal.id,
        commandId: reversal.commandId,
        type: "X_REVERSAL",
        summary: `Reversed: ${describe(tx)}`,
        actor: await actorLabel(reversal.commandId),
        note: ctx.ledger.commands.get(reversal.commandId)?.note ?? null,
        securityId: target,
      });
    }
  }
  const { results: signatures } = await ctx.db.prepare(
    "SELECT id, security_id, status, signer_role, signed_at, resolved_at, created_at FROM signature_requests WHERE org_id = ? AND security_id = ?",
  ).bind(ctx.org.id, securityId).all<{ id: string; security_id: string; status: string; signer_role: string; signed_at: number | null; resolved_at: number | null; created_at: number }>();
  for (const row of signatures) {
    entries.push({
      kind: "signature",
      at: row.signed_at ?? row.resolved_at ?? row.created_at,
      effectiveDate: null,
      transactionId: null,
      commandId: null,
      type: row.status,
      summary: `${row.signer_role.toLowerCase().replace("_", " ")} signature ${row.status.toLowerCase()}`,
      actor: null,
      note: null,
      securityId,
    });
  }
  const { results: links } = await ctx.db.prepare(
    `SELECT l.created_at, l.role, l.revoked_at, d.filename FROM document_links l JOIN documents d ON d.org_id = l.org_id AND d.id = l.document_id
     WHERE l.org_id = ? AND l.security_id = ?`,
  ).bind(ctx.org.id, securityId).all<{ created_at: number; role: string; revoked_at: number | null; filename: string }>();
  for (const link of links) {
    entries.push({
      kind: "document",
      at: link.created_at,
      effectiveDate: null,
      transactionId: null,
      commandId: null,
      type: link.revoked_at === null ? "document.linked" : "document.link_revoked",
      summary: `${link.role.toLowerCase()} document linked`,
      actor: null,
      note: null,
      securityId,
    });
  }
  return entries.sort((a, b) => a.at - b.at || (a.effectiveDate ?? "").localeCompare(b.effectiveDate ?? ""));
}

/** What terminating the holder on a date would do to this security (the API contracttermination preview). */
export function securityTerminationPreview(state: engine.LedgerState, securityId: string, query: { terminationDate: string; terminationType: engine.TerminationType; vestingStopDate?: string | undefined }): api.TerminationPreview {
  const security = issuedSecurityOr404(state, securityId);
  const stop = query.vestingStopDate ?? query.terminationDate;
  const effect = engine.terminationPreview(state, security.identity.stakeholderId, { terminationDate: query.terminationDate, terminationType: query.terminationType, vestingStopDate: stop })
    .find((e) => e.securityId === securityId);
  const isStock = security.identity.family === "STOCK";
  return api.terminationPreviewSchema.parse({
    securityId,
    terminationDate: query.terminationDate,
    terminationType: query.terminationType,
    vestingStopDate: stop,
    vested: dec(effect ? effect.vestedAtStop.add(effect.acceleration) : engine.positionAt(state, security, stop).vested),
    unvested: dec(effect ? (isStock ? effect.unvestedShares : effect.cancel) : engine.Dec.ZERO),
    exercisable: dec(effect && !isStock ? effect.keep : engine.Dec.ZERO),
    repurchaseable: dec(effect && isStock ? effect.unvestedShares : engine.Dec.ZERO),
    contractualDeadline: effect?.contractualDeadline ?? null,
    isoDeadline: effect?.isoDeadline ?? null,
  });
}
