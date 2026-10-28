import { api, engine } from "#shared";
import { ApiError, notFound } from "../http.ts";
import { stmt, type Stmt } from "../ledger/statements.ts";
import { exactDecimal, userActorLabels, type ReadContext } from "./context.ts";

/**
 * 409A valuations (the API contract): immutable rows whose status for a date is computed from their dates and their
 * append-only events. The engine picks the FMV a grant or an exercise snapshots from the same rows.
 */

export interface ValuationRow extends engine.ValuationRecord {
  name: string;
  provider: string | null;
  valuationType: "409A" | "OTHER";
  boardApprovalDate: string | null;
  reportVersion: "FINAL" | "DRAFT";
  reportDocumentId: string | null;
  importedFromPulley: boolean;
  createdBy: string | null;
  createdAt: number;
  eventRows: {
    id: string;
    kind: engine.ValuationEventKind;
    eventDate: string;
    description: string;
    documentId: string | null;
    reversesEventId: string | null;
    createdBy: string;
    createdAt: number;
  }[];
}

export async function loadValuations(db: D1Database, orgId: string): Promise<ValuationRow[]> {
  const [valuations, prices, events] = await db.batch([
    db.prepare(
      `SELECT id, valuation_type, name, provider, effective_date, expiration_date, board_approval_date, report_version,
              report_document_id, created_by, created_at, pulley_id
       FROM valuations WHERE org_id = ? ORDER BY effective_date DESC, id`,
    ).bind(orgId),
    db.prepare("SELECT valuation_id, stock_class_id, price_per_share FROM valuation_prices WHERE org_id = ?").bind(orgId),
    db.prepare(
      `SELECT id, valuation_id, kind, event_date, description, document_id, reverses_event_id, created_by, created_at
       FROM valuation_events WHERE org_id = ? ORDER BY event_date, created_at, id`,
    ).bind(orgId),
  ]);
  const priceRows = (prices?.results ?? []) as { valuation_id: string; stock_class_id: string; price_per_share: string }[];
  const eventRows = (events?.results ?? []) as {
    id: string; valuation_id: string; kind: engine.ValuationEventKind; event_date: string; description: string;
    document_id: string | null; reverses_event_id: string | null; created_by: string; created_at: number;
  }[];
  return ((valuations?.results ?? []) as {
    id: string; valuation_type: "409A" | "OTHER"; name: string; provider: string | null; effective_date: string;
    expiration_date: string | null; board_approval_date: string | null; report_version: "FINAL" | "DRAFT";
    report_document_id: string | null; created_by: string | null; created_at: number; pulley_id: string | null;
  }[]).map((row) => {
    const own = eventRows.filter((event) => event.valuation_id === row.id);
    return {
      id: row.id,
      effectiveDate: row.effective_date,
      expirationDate: row.expiration_date,
      prices: priceRows.filter((price) => price.valuation_id === row.id).map((price) => ({ stockClassId: price.stock_class_id, pricePerShare: price.price_per_share })),
      events: own.map((event) => ({ id: event.id, kind: event.kind, eventDate: event.event_date, reversesEventId: event.reverses_event_id, createdAt: event.created_at })),
      name: row.name,
      provider: row.provider,
      valuationType: row.valuation_type,
      boardApprovalDate: row.board_approval_date,
      reportVersion: row.report_version,
      reportDocumentId: row.report_document_id,
      importedFromPulley: row.pulley_id !== null,
      createdBy: row.created_by,
      createdAt: row.created_at,
      eventRows: own.map((event) => ({
        id: event.id,
        kind: event.kind,
        eventDate: event.event_date,
        description: event.description,
        documentId: event.document_id,
        reversesEventId: event.reverses_event_id,
        createdBy: event.created_by,
        createdAt: event.created_at,
      })),
    };
  });
}

/**
 * A batch assertion that the org's valuations are as they were read (the API contract). Valuations, their prices and their
 * events are append-only (triggers), so their counts move on any change: a valuation recorded, priced, flagged, cleared
 * or voided between a read and the batch that relied on it aborts that batch, and the request answers 409
 * `state_changed`.
 */
export function valuationGuard(orgId: string, rows: readonly ValuationRow[]): Stmt {
  const events = rows.reduce((count, row) => count + row.eventRows.length, 0);
  const prices = rows.reduce((count, row) => count + row.prices.length, 0);
  return stmt(
    `INSERT INTO batch_assertions (ok) SELECT (SELECT COUNT(*) FROM valuations WHERE org_id = ?1) = ?2
       AND (SELECT COUNT(*) FROM valuation_events WHERE org_id = ?1) = ?3 AND (SELECT COUNT(*) FROM valuation_prices WHERE org_id = ?1) = ?4`,
    orgId, rows.length, events, prices,
  );
}

/**
 * The FMV of a class on a date, split-adjusted (engine `fmvOn` with the class's splits from the ledger): the one figure
 * the FMV endpoint shows, a grant's strike is checked against, and a grant or an exercise snapshots.
 */
export function classFmvOn(state: engine.LedgerState, rows: readonly ValuationRow[], date: string, stockClassId: string): engine.FmvLookup {
  return engine.fmvOn(rows, date, stockClassId, state.classes.get(stockClassId)?.splits ?? []);
}
/**
 * The status shown for a valuation: as of today, or, for one recorded before it takes effect, as of its effective date
 * (`statusAsOf` says which), since the API has no "not yet effective" status.
 */
export function valuationJson(row: ValuationRow, all: readonly ValuationRow[], today: string, labels: Map<string, string>): api.Valuation {
  const statusAsOf = row.effectiveDate > today ? row.effectiveDate : today;
  const computed = engine.valuationStatus(row, all, statusAsOf);
  const status: api.Valuation["status"] = computed === "not_yet_effective" ? "presumptively_valid" : computed;
  // Presumptive validity is a final 409A's: another type has a status of its own type's chain, and a draft report has
  // status `draft`; neither ever has a validity date.
  const valid = row.valuationType === "409A" && row.reportVersion === "FINAL" && (status === "presumptively_valid" || status === "expiring_soon");
  return {
    id: row.id,
    name: row.name,
    valuationType: row.valuationType,
    provider: row.provider,
    effectiveDate: row.effectiveDate,
    expirationDate: row.expirationDate,
    boardApprovalDate: row.boardApprovalDate,
    reportVersion: row.reportVersion,
    prices: row.prices.map((price) => ({ stockClassId: price.stockClassId, pricePerShare: price.pricePerShare })),
    status,
    statusAsOf,
    presumptivelyValidUntil: valid ? row.expirationDate : null,
    events: row.eventRows.map((event) => ({
      id: event.id,
      kind: event.kind,
      eventDate: event.eventDate,
      description: event.description,
      documentId: event.documentId,
      reversesEventId: event.reversesEventId,
      createdBy: labels.get(event.createdBy) ?? "Unknown",
      createdAt: event.createdAt,
    })),
    reportDocumentId: row.reportDocumentId,
    importedFromPulley: row.importedFromPulley,
  };
}

export async function valuationList(ctx: ReadContext): Promise<api.ValuationList> {
  const rows = await loadValuations(ctx.db, ctx.org.id);
  const labels = await userActorLabels(
    ctx.db,
    rows.flatMap((row) => row.eventRows.map((event) => event.createdBy)),
    ctx.viewer.pii,
  );
  return api.valuationListSchema.parse({ items: rows.map((row) => valuationJson(row, rows, ctx.today, labels)) });
}

export async function valuationDetail(ctx: ReadContext, state: engine.LedgerState, valuationId: string): Promise<api.ValuationDetail> {
  const rows = await loadValuations(ctx.db, ctx.org.id);
  const row = rows.find((v) => v.id === valuationId);
  if (!row) throw notFound("Valuation not found");
  const labels = await userActorLabels(ctx.db, row.eventRows.map((event) => event.createdBy), ctx.viewer.pii);
  const { results: documents } = await ctx.db.prepare(
    `SELECT DISTINCT d.id, d.filename, d.kind FROM documents d WHERE d.org_id = ?1 AND d.archived_at IS NULL AND (d.id = ?2 OR d.id IN (
       SELECT document_id FROM document_links WHERE org_id = ?1 AND valuation_id = ?3 AND revoked_at IS NULL))`,
  ).bind(ctx.org.id, row.reportDocumentId, valuationId).all<{ id: string; filename: string; kind: api.DocumentRef["kind"] }>();
  const grants: api.ValuationDetail["grants"] = [];
  const applied = new Map(state.applied.map((tx) => [tx.id, tx]));
  for (const security of state.securities.values()) {
    if (!security.issued || security.identity.family !== "EQUITY_COMPENSATION" || security.origin !== "GRANT") continue;
    const issuance = security.issuance ? applied.get(security.issuance.transactionId) : undefined;
    const fmv = (issuance?.payload as { x_fmv?: { valuation_id?: string | null } } | undefined)?.x_fmv;
    if (fmv?.valuation_id !== valuationId) continue;
    // The class the option delivers, so its strike is compared with that class's FMV (the admin UI).
    const stockClassId = security.identity.stockClassId
      ?? (security.identity.stockPlanId ? (state.plans.get(security.identity.stockPlanId)?.ref.stockClassId ?? null) : null);
    grants.push({
      securityId: security.identity.id,
      displayId: security.identity.displayId,
      stakeholderId: security.identity.stakeholderId,
      grantDate: security.issueDate!,
      exercisePrice: exactDecimal(security.exercisePriceAtGrant) ?? "0",
      ...(stockClassId !== null ? { stockClassId } : {}),
    });
  }
  return api.valuationDetailSchema.parse({
    ...valuationJson(row, rows, ctx.today, labels),
    documents: documents.map((d) => ({ id: d.id, filename: d.filename, kind: d.kind })),
    grants,
  });
}

/** The FMV in effect on a date (the API contract): the presumptively valid valuation, adjusted for later splits of the class. */
export async function fmvLookup(ctx: ReadContext, state: engine.LedgerState, query: { date: string; stockClassId?: string | undefined }): Promise<api.FmvResponse> {
  const commons = ctx.ledger.reference.stockClasses.filter((c) => c.classType === "COMMON");
  const stockClassId = query.stockClassId ?? (commons.length === 1 ? commons[0]!.id : null);
  if (stockClassId === null) throw new ApiError("validation_failed", "Name the stock class", [{ path: "stockClassId", message: "The org has more than one common class" }]);
  const stockClass = state.classes.get(stockClassId);
  if (!stockClass) throw notFound("Stock class not found");
  const rows = await loadValuations(ctx.db, ctx.org.id);
  const lookup = classFmvOn(state, rows, query.date, stockClassId);
  if (!lookup.valid) return api.fmvResponseSchema.parse({ date: query.date, stockClassId, fmv: null });
  const row = rows.find((v) => v.id === lookup.valuation.id)!;
  return api.fmvResponseSchema.parse({
    date: query.date,
    stockClassId,
    fmv: { valuationId: row.id, valuationName: row.name, pricePerShare: lookup.pricePerShare.toString(), splitAdjusted: lookup.splitAdjusted, status: lookup.status },
  });
}
