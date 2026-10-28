import { api, engine } from "#shared";
import { notFound } from "../http.ts";
import { userActorLabels } from "../read/context.ts";
import { loadValuations, valuationGuard, valuationJson, type ValuationRow } from "../read/valuations.ts";
import { assertConfirmation, violation } from "./commands/common.ts";
import { CommandDocuments } from "./documents.ts";
import { conflict, invariantViolation, type ApiViolation } from "./errors.ts";
import { uuidv7 } from "./ids.ts";
import { requestSha256 } from "./run.ts";
import { auditInsert, stmt } from "./statements.ts";
import type { BatchStatement, CommandContext, DocumentUse } from "./types.ts";
import { commitWorkflow, replayed, type StoredResponse } from "./workflow.ts";

/**
 * 409A valuations (the API contract; the product rules). A valuation and its prices are immutable rows, and what
 * changes a valuation's status (a material event, a review cleared, a void, a flag reversed) is an append-only event:
 * nothing here ever writes a transaction or changes a number for any date (the ledger rules). Grants and exercises snapshot
 * the FMV and the valuation id in their payloads, so recording, flagging or voiding a valuation changes only what the
 * next grant or exercise may use; the batch of every such write asserts the valuations it read are unchanged
 * (`valuationGuard`), and grants and exercises assert the same.
 */

export interface WorkflowRequest {
  route: string;
  path: string;
  key: string;
}

type ValuationEventKind = "MATERIAL_EVENT" | "REVIEW_CLEARED" | "VOIDED" | "EVENT_REVERSED";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "<Mon YYYY> Valuation" from the effective date (the product rules). */
function defaultName(effectiveDate: string): string {
  return `${MONTHS[Number(effectiveDate.slice(5, 7)) - 1]} ${effectiveDate.slice(0, 4)} Valuation`;
}

function audit(ctx: CommandContext, action: string, valuationId: string, details: Record<string, unknown>): BatchStatement {
  return auditInsert({
    occurredAt: ctx.now, orgId: ctx.org.id, actorKind: ctx.actor.kind, actorUserId: ctx.actor.userId, actorEmail: ctx.actor.email,
    authMethod: ctx.actor.authMethod, action, targetType: "valuation", targetId: valuationId, result: "success",
    ip: ctx.actor.ip ?? null, userAgent: ctx.actor.userAgent ?? null, requestId: ctx.actor.requestId ?? null, details,
  });
}

/** Documents a valuation write relies on: each must exist in the org and not be archived; the batch links them. */
async function documentStatements(ctx: CommandContext, uses: readonly DocumentUse[], violations: ApiViolation[]): Promise<() => Promise<BatchStatement[]>> {
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  await documents.requireAll(uses.map((use) => use.documentId));
  violations.push(...await documents.check(uses, () => null));
  return () => documents.statements(uses, { now: ctx.now, actorUserId: ctx.actor.userId, transactionIds: [] });
}

/** The valuation's answer once the batch commits: its row with the new event, its status as of today. */
async function responseFor(ctx: CommandContext, rows: readonly ValuationRow[], row: ValuationRow): Promise<api.Valuation> {
  const all = rows.map((other) => (other.id === row.id ? row : other));
  if (!all.includes(row)) all.push(row);
  // A read-write administrator sees PII, so labels are not masked.
  const labels = await userActorLabels(ctx.db, row.eventRows.map((event) => event.createdBy), true);
  return api.valuationSchema.parse(valuationJson(row, all, ctx.today, labels));
}

function valuationOr404(rows: readonly ValuationRow[], valuationId: string): ValuationRow {
  const row = rows.find((candidate) => candidate.id === valuationId);
  if (!row) throw notFound("Valuation not found");
  return row;
}

/** A valuation with one more event, as `loadValuations` would read it after the batch. */
function withEvent(row: ValuationRow, event: NewEvent, ctx: CommandContext): ValuationRow {
  const createdBy = ctx.actor.userId ?? "";
  return {
    ...row,
    events: [...row.events, { id: event.id, kind: event.kind, eventDate: event.eventDate, reversesEventId: event.reversesEventId, createdAt: event.createdAt }],
    eventRows: [...row.eventRows, { ...event, createdBy }],
  };
}

type NewEvent = { id: string; kind: ValuationEventKind; eventDate: string; description: string; documentId: string | null; reversesEventId: string | null; createdAt: number };

/**
 * The new event's recording ordinal, stored as `created_at` (the API contractorders same-day events by it): the request's
 * time, or one more than the org's latest event if that is later. The batch's valuation guard asserts no event was
 * recorded since the read, so the ordinal is strictly increasing in recording order, even within one millisecond or
 * with a lagging clock.
 */
function nextEventOrdinal(ctx: CommandContext, rows: readonly ValuationRow[]): number {
  const latest = Math.max(0, ...rows.flatMap((row) => row.eventRows.map((event) => event.createdAt)));
  return Math.max(ctx.now, latest + 1);
}

function eventInsert(ctx: CommandContext, valuationId: string, event: NewEvent): BatchStatement {
  return stmt(
    `INSERT INTO valuation_events (id, org_id, valuation_id, kind, event_date, description, document_id, reverses_event_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id, ctx.org.id, valuationId, event.kind, event.eventDate, event.description, event.documentId, event.reversesEventId, ctx.actor.userId, event.createdAt,
  );
}

function notInFuture(ctx: CommandContext, eventDate: string, violations: ApiViolation[]): void {
  if (eventDate > ctx.today) violations.push(violation("EVENT_DATE_IN_FUTURE", `The event date is after today (${ctx.today})`));
}

/** `POST …/valuations`: a 409A with its report, prices per class (common required), immutable once recorded. */
export async function recordValuation(ctx: CommandContext, body: api.RecordValuationRequest, request: WorkflowRequest): Promise<StoredResponse> {
  const hash = requestSha256(request.route, request.path, body);
  const prior = await replayed(ctx, request.route, request.key, hash);
  if (prior) return prior;
  const rows = await loadValuations(ctx.db, ctx.org.id);
  const violations: ApiViolation[] = [];
  const classes = new Map(ctx.ledger.reference.stockClasses.map((stockClass) => [stockClass.id, stockClass]));
  const priced = new Set<string>();
  for (const price of body.prices) {
    if (!classes.has(price.stockClassId)) throw notFound("Stock class not found");
    if (priced.has(price.stockClassId)) violations.push(violation("DUPLICATE_CLASS_PRICE", "Each class has one price per valuation"));
    priced.add(price.stockClassId);
  }
  if (![...priced].some((id) => classes.get(id)?.classType === "COMMON")) {
    violations.push(violation("COMMON_PRICE_REQUIRED", "A 409A prices the common stock: add the common class's FMV"));
  }
  const expirationDate = body.expirationDate ?? engine.addMonths(body.effectiveDate, 12);
  if (expirationDate <= body.effectiveDate) {
    violations.push(violation("EXPIRATION_NOT_AFTER_EFFECTIVE", "The expiration date must be after the effective date"));
  }
  // Two 409As in effect from the same day would leave "the valuation in effect" ambiguous for every date until one is
  // voided. Another one on that date may be recorded only once it never took effect (voided on or before that date,
  // or a draft report, which never takes effect); the batch's valuation guard keeps this true until the commit.
  if (rows.some((row) => row.valuationType === "409A" && row.effectiveDate === body.effectiveDate && engine.tookEffect(row))) {
    violations.push(violation("VALUATION_ON_DATE_EXISTS", `A valuation already takes effect on ${body.effectiveDate}; void it before recording another`));
  }
  const id = uuidv7(ctx.now);
  const uses: DocumentUse[] = [{ documentId: body.reportDocumentId, role: "REPORT", target: { type: "valuation", id } }];
  if (body.boardConsentDocumentId !== undefined) uses.push({ documentId: body.boardConsentDocumentId, role: "CONSENT", target: { type: "valuation", id } });
  const links = await documentStatements(ctx, uses, violations);
  if (violations.length > 0) throw invariantViolation(violations);

  const row: ValuationRow = {
    id,
    effectiveDate: body.effectiveDate,
    expirationDate,
    prices: body.prices.map((price) => ({ stockClassId: price.stockClassId, pricePerShare: price.pricePerShare })),
    events: [],
    name: body.name?.trim() || defaultName(body.effectiveDate),
    provider: body.provider,
    valuationType: "409A",
    boardApprovalDate: body.boardApprovalDate ?? null,
    reportVersion: "FINAL",
    reportDocumentId: body.reportDocumentId,
    importedFromPulley: false,
    createdBy: ctx.actor.userId,
    createdAt: ctx.now,
    eventRows: [],
  };
  const statements: BatchStatement[] = [
    valuationGuard(ctx.org.id, rows),
    stmt(
      `INSERT INTO valuations (id, org_id, valuation_type, name, provider, effective_date, expiration_date, board_approval_date, report_version,
         method_notes, report_document_id, created_by, created_at)
       VALUES (?, ?, '409A', ?, ?, ?, ?, ?, 'FINAL', ?, ?, ?, ?)`,
      id, ctx.org.id, row.name, row.provider, row.effectiveDate, expirationDate, row.boardApprovalDate, body.methodNotes ?? null,
      body.reportDocumentId, ctx.actor.userId, ctx.now,
    ),
    ...body.prices.map((price) => stmt(
      "INSERT INTO valuation_prices (org_id, valuation_id, stock_class_id, price_per_share) VALUES (?, ?, ?, ?)",
      ctx.org.id, id, price.stockClassId, price.pricePerShare,
    )),
    ...await links(),
    audit(ctx, "valuation.recorded", id, { effectiveDate: row.effectiveDate, expirationDate, prices: body.prices.length, reportDocumentId: body.reportDocumentId }),
  ];
  return commitWorkflow(ctx, statements, { route: request.route, key: request.key, hash, body: await responseFor(ctx, rows, row), status: 201 });
}

/**
 * `POST …/valuations/material-events`: appends MATERIAL_EVENT to the valuation presumptively valid on the
 * event date. It now requires review: new grants are blocked and the dashboard reminds until a new valuation is
 * recorded or an administrator records written confirmation that it still holds.
 */
export async function flagMaterialEvent(ctx: CommandContext, body: api.MaterialEventRequest, request: WorkflowRequest): Promise<StoredResponse> {
  const hash = requestSha256(request.route, request.path, body);
  const prior = await replayed(ctx, request.route, request.key, hash);
  if (prior) return prior;
  const rows = await loadValuations(ctx.db, ctx.org.id);
  const violations: ApiViolation[] = [];
  notInFuture(ctx, body.eventDate, violations);
  const target = engine.presumptivelyValidOn(rows, body.eventDate);
  if (target === null) violations.push(violation("NO_PRESUMPTIVELY_VALID_409A", `No 409A is presumptively valid on ${body.eventDate} to flag`));
  const eventId = uuidv7(ctx.now);
  const uses: DocumentUse[] = target !== null && body.documentId !== undefined ? [{ documentId: body.documentId, role: "EVIDENCE", target: { type: "valuation", id: target.id } }] : [];
  const links = await documentStatements(ctx, uses, violations);
  if (violations.length > 0 || target === null) throw invariantViolation(violations);
  const row = valuationOr404(rows, target.id);
  const event = { id: eventId, kind: "MATERIAL_EVENT" as const, eventDate: body.eventDate, description: body.description, documentId: body.documentId ?? null, reversesEventId: null, createdAt: nextEventOrdinal(ctx, rows) };
  const statements: BatchStatement[] = [
    valuationGuard(ctx.org.id, rows),
    eventInsert(ctx, row.id, event),
    ...await links(),
    audit(ctx, "valuation.material_event", row.id, { eventId, eventDate: body.eventDate, documentId: body.documentId ?? null }),
  ];
  return commitWorkflow(ctx, statements, { route: request.route, key: request.key, hash, body: await responseFor(ctx, rows, withEvent(row, event, ctx)) });
}

/** `POST …/valuations/:id/review-cleared`: written provider or counsel confirmation ends the review. */
export async function clearValuationReview(ctx: CommandContext, valuationId: string, body: api.ReviewClearedRequest, request: WorkflowRequest): Promise<StoredResponse> {
  const hash = requestSha256(request.route, request.path, body);
  const prior = await replayed(ctx, request.route, request.key, hash);
  if (prior) return prior;
  const rows = await loadValuations(ctx.db, ctx.org.id);
  const row = valuationOr404(rows, valuationId);
  const violations: ApiViolation[] = [];
  notInFuture(ctx, body.eventDate, violations);
  if (engine.valuationStatus(row, rows, body.eventDate) !== "review_required") {
    violations.push(violation("NO_REVIEW_REQUIRED", `${row.name} doesn't require review on ${body.eventDate}`));
  }
  const links = await documentStatements(ctx, [{ documentId: body.documentId, role: "EVIDENCE", target: { type: "valuation", id: row.id } }], violations);
  if (violations.length > 0) throw invariantViolation(violations);
  const event = { id: uuidv7(ctx.now), kind: "REVIEW_CLEARED" as const, eventDate: body.eventDate, description: body.description, documentId: body.documentId, reversesEventId: null, createdAt: nextEventOrdinal(ctx, rows) };
  const statements: BatchStatement[] = [
    valuationGuard(ctx.org.id, rows),
    eventInsert(ctx, row.id, event),
    ...await links(),
    audit(ctx, "valuation.review_cleared", row.id, { eventId: event.id, eventDate: body.eventDate, documentId: body.documentId }),
  ];
  return commitWorkflow(ctx, statements, { route: request.route, key: request.key, hash, body: await responseFor(ctx, rows, withEvent(row, event, ctx)) });
}

/**
 * `POST …/valuations/:id/events/:eventId/reverse` (typed confirmation): a material-event flag raised in error
 * counts for nothing, from its own date, once (unique index; trigger). A recorded 409A itself is never reversed: a
 * corrected valuation supersedes it. The confirmation is the valuation's name, exactly (the contract's rule).
 */
export async function reverseValuationEvent(
  ctx: CommandContext,
  valuationId: string,
  eventId: string,
  body: api.ReverseValuationEventRequest,
  request: WorkflowRequest,
): Promise<StoredResponse> {
  const hash = requestSha256(request.route, request.path, body);
  const prior = await replayed(ctx, request.route, request.key, hash);
  if (prior) return prior;
  const rows = await loadValuations(ctx.db, ctx.org.id);
  const row = valuationOr404(rows, valuationId);
  const flagged = row.eventRows.find((event) => event.id === eventId);
  if (!flagged) throw notFound("Valuation event not found");
  if (flagged.kind !== "MATERIAL_EVENT") {
    throw invariantViolation([violation("EVENT_NOT_REVERSIBLE", "Only a material-event flag can be reversed; record a corrected valuation instead")]);
  }
  if (row.eventRows.some((event) => event.kind === "EVENT_REVERSED" && event.reversesEventId === eventId)) {
    throw conflict("state_changed", "That flag is already reversed");
  }
  assertConfirmation(body.confirmation, [row.name]);
  const event = { id: uuidv7(ctx.now), kind: "EVENT_REVERSED" as const, eventDate: flagged.eventDate, description: body.note, documentId: null, reversesEventId: eventId, createdAt: nextEventOrdinal(ctx, rows) };
  const statements: BatchStatement[] = [
    valuationGuard(ctx.org.id, rows),
    eventInsert(ctx, row.id, event),
    audit(ctx, "valuation.event_reversed", row.id, { eventId: event.id, reversesEventId: eventId }),
  ];
  return commitWorkflow(ctx, statements, { route: request.route, key: request.key, hash, body: await responseFor(ctx, rows, withEvent(row, event, ctx)) });
}

/**
 * `POST …/valuations/:id/void`: a valuation recorded in error stops counting from the void's date. Grants and
 * exercises it priced keep their snapshot (the ledger rules: voiding a 409A never changes a past grant).
 */
export async function voidValuation(ctx: CommandContext, valuationId: string, body: api.VoidValuationRequest, request: WorkflowRequest): Promise<StoredResponse> {
  const hash = requestSha256(request.route, request.path, body);
  const prior = await replayed(ctx, request.route, request.key, hash);
  if (prior) return prior;
  const rows = await loadValuations(ctx.db, ctx.org.id);
  const row = valuationOr404(rows, valuationId);
  if (row.eventRows.some((event) => event.kind === "VOIDED")) throw conflict("state_changed", "That valuation is already voided");
  const violations: ApiViolation[] = [];
  notInFuture(ctx, body.eventDate, violations);
  const uses: DocumentUse[] = body.documentId !== undefined ? [{ documentId: body.documentId, role: "EVIDENCE", target: { type: "valuation", id: row.id } }] : [];
  const links = await documentStatements(ctx, uses, violations);
  if (violations.length > 0) throw invariantViolation(violations);
  const event = { id: uuidv7(ctx.now), kind: "VOIDED" as const, eventDate: body.eventDate, description: body.description, documentId: body.documentId ?? null, reversesEventId: null, createdAt: nextEventOrdinal(ctx, rows) };
  const statements: BatchStatement[] = [
    valuationGuard(ctx.org.id, rows),
    eventInsert(ctx, row.id, event),
    ...await links(),
    audit(ctx, "valuation.voided", row.id, { eventId: event.id, eventDate: body.eventDate, documentId: body.documentId ?? null }),
  ];
  return commitWorkflow(ctx, statements, { route: request.route, key: request.key, hash, body: await responseFor(ctx, rows, withEvent(row, event, ctx)) });
}
