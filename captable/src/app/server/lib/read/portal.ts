import { api, engine } from "#shared";
import type { PortalMatch } from "../access/resolve.ts";
import type { AppConfig } from "../config.ts";
import type { DocumentRow } from "../documents/types.ts";
import {
  evaluateHolderDocumentAccess, HOLDER_VISIBLE_DOCUMENT_SQL, listHolderDocuments, resolvedDocumentHoldersByDocument,
} from "../documents/visibility.ts";
import { notFound } from "../http.ts";
import { maskPaymentInstructionDetails, parsePaymentInstructionDetails } from "../payment-instructions.ts";
import { dec, decOrNull, exactDecimal, holdingsView, loadReadContext, replayed, type ReadContext, type Viewer } from "./context.ts";
import { importedFromPulley, legendsOf, securityTermsOf } from "./securities.ts";
import { windowJson } from "./structure.ts";

/**
 * The holder portal's answers (the API contract), built only from the strict allowlist schemas and only from the caller's
 * own matched stakeholder records: no fully diluted figures, no percentages, no other holders, no org totals. Each
 * answer is parsed before it leaves, so an unexpected key fails the request instead of leaking. The admin's
 * "Preview as stakeholder" reads (the API contract) answer with the very same builders for the previewed stakeholder.
 */

const HOLDER_VIEWER: Viewer = { access: "admin_ro", fullAccess: false, pii: false, userId: null, email: null };
/** Awaiting signatures (the product rules): nothing is exercisable until both sides have signed. */
const PENDING_EXECUTION = new Set<engine.ExecutionStatus>(["pending_company", "pending_holder", "pending_both"]);
const ORIGIN_KINDS: Partial<Record<string, "exercise" | "conversion" | "transfer">> = { EXERCISE: "exercise", CONVERSION: "conversion", TRANSFER: "transfer" };

export const DEFAULT_HOW_TO_EXERCISE =
  "To exercise vested options, download the notice of exercise, complete and sign it, and send it to the company contact. "
  + "Then pay the exercise price using the payment instructions on this page, quoting your reference. Your exercise is "
  + "recorded once the company has received both the signed notice and the full payment. We never send bank details by e-mail.";

function portalStatus(status: engine.SecurityStatus): api.PortalSecurity["status"] | null {
  return status === "RETRACTED" ? null : status;
}

function vestingStatus(event: engine.VestingTimelineEvent, asOf: string): "VESTED" | "UPCOMING" | "STOPPED" {
  if (event.state === "CANCELLED") return "STOPPED";
  return event.date <= asOf ? "VESTED" : "UPCOMING";
}

/** A lot of the caller's own, issued and never retracted: the only other lots a portal answer may name. */
function ownLot(state: engine.LedgerState, id: string | null, ownIds: ReadonlySet<string>): engine.SecurityState | null {
  const lot = id === null ? undefined : state.securities.get(id);
  return lot !== undefined && lot.issued && !lot.retracted && ownIds.has(lot.identity.stakeholderId) ? lot : null;
}

function classNameOf(state: engine.LedgerState, security: engine.SecurityState): string | null {
  const classId = security.identity.stockClassId ?? (security.identity.stockPlanId ? (state.plans.get(security.identity.stockPlanId)?.ref.stockClassId ?? null) : null);
  return classId ? (state.classes.get(classId)?.ref.name ?? null) : null;
}

/**
 * The caller's own documents linked to each security: the portal's visibility policy (`HOLDER_VISIBLE_DOCUMENT_SQL`,
 * which the Documents page applies too) on a live security link, then the same ownership check (one holder, theirs).
 */
async function holderDocuments(ctx: ReadContext, ownIds: ReadonlySet<string>, securityIds: readonly string[]): Promise<Map<string, api.PortalDocument[]>> {
  const bySecurity = new Map<string, api.PortalDocument[]>();
  if (securityIds.length === 0) return bySecurity;
  const { results } = await ctx.db.prepare(
    `SELECT d.*, l.security_id AS linked_security_id FROM document_links l JOIN documents d ON d.org_id = l.org_id AND d.id = l.document_id
     WHERE l.org_id = ? AND l.revoked_at IS NULL AND l.security_id IN (SELECT value FROM json_each(?))
       AND ${HOLDER_VISIBLE_DOCUMENT_SQL} ORDER BY d.created_at, d.id`,
  ).bind(ctx.org.id, JSON.stringify(securityIds)).all<DocumentRow & { linked_security_id: string }>();
  const holders = await resolvedDocumentHoldersByDocument(ctx.db, ctx.org.id, results.map((row) => row.id));
  for (const row of results) {
    if (evaluateHolderDocumentAccess(row, holders.get(row.id)!, ownIds) !== "mine") continue;
    const list = bySecurity.get(row.linked_security_id) ?? [];
    if (!list.some((document) => document.id === row.id)) {
      list.push(api.portalDocumentSchema.parse({ id: row.id, filename: row.filename, kind: row.kind, createdAt: row.created_at, scope: "mine" }));
    }
    bySecurity.set(row.linked_security_id, list);
  }
  return bySecurity;
}

export function portalSecurityJson(
  ctx: ReadContext,
  state: engine.LedgerState,
  security: engine.SecurityState,
  ownIds: ReadonlySet<string>,
  documents: Map<string, api.PortalDocument[]>,
): api.PortalSecurity | null {
  const status = portalStatus(security.status);
  if (!security.issued || security.retracted || status === null) return null;
  const family = security.identity.family;
  const position = engine.positionAt(state, security, state.asOf);
  const plan = security.identity.stockPlanId ? state.plans.get(security.identity.stockPlanId) : undefined;
  const convertible = family === "CONVERTIBLE";
  const stock = family === "STOCK";
  const awardLike = family === "EQUITY_COMPENSATION" || family === "WARRANT";
  const subtype = security.identity.subtype;
  const result: api.PortalSecurity = {
    id: security.identity.id,
    orgId: ctx.org.id,
    displayId: security.identity.displayId,
    family,
    optionType: subtype === "OPTION_ISO" ? "ISO" : subtype === "OPTION_NSO" ? "NSO" : null,
    className: classNameOf(state, security),
    planName: plan?.ref.name ?? null,
    issueDate: security.issueDate!,
    status,
    executionPending: PENDING_EXECUTION.has(security.executionStatus),
    exercisePrice: awardLike ? exactDecimal(security.exercisePrice) : null,
    expirationDate: awardLike ? security.expirationDate : null,
    contractualDeadline: awardLike ? (engine.contractualDeadline(security)?.date ?? null) : null,
    isoDeadline: subtype === "OPTION_ISO" ? (engine.isoDeadline(state, security)?.date ?? null) : null,
    numbers: {
      asOf: state.asOf,
      granted: dec(security.issuedQuantity),
      outstanding: dec(security.outstanding),
      vested: convertible ? null : dec(position.vested),
      unvested: convertible ? null : dec(position.unvestedOutstanding),
      exercised: awardLike ? dec(security.exercised.add(security.released)) : null,
      exercisable: awardLike ? dec(engine.exercisability(state, security).exercisable) : null,
      cancelled: stock ? null : dec(security.cancelled),
    },
    vesting: convertible ? [] : engine.securityVestingTimeline(state, security).map((event) => ({
      date: event.date,
      quantity: dec(event.quantity),
      cumulative: dec(event.cumulative),
      status: vestingStatus(event, state.asOf),
    })),
    documents: documents.get(security.identity.id) ?? [],
  };
  if (convertible) {
    // A SAFE's converted history: only lots the caller holds (the allowlist test rejects any other holder's lot).
    result.convertedInto = security.resultingSecurityIds
      .map((id) => ownLot(state, id, ownIds))
      .filter((lot): lot is engine.SecurityState => lot !== null)
      .map((lot) => ({ displayId: lot.identity.displayId }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// The holding detail (the product rules: option, share, warrant and SAFE detail)

/**
 * The windows a termination would apply, one per reason: the grant's own, else the plan default in force at grant
 * (the rule the engine's deadlines use, `engine.windowSource`).
 */
function postTerminationPeriods(state: engine.LedgerState, security: engine.SecurityState): api.TerminationWindow[] {
  const terms = engine.planTermsOn(state, security.identity.stockPlanId, security.issueDate ?? state.asOf);
  const windows: api.TerminationWindow[] = [];
  for (const reason of api.TERMINATION_WINDOW_REASONS) {
    const ocf = engine.API_WINDOW_REASON[reason];
    const window = security.terminationWindows.find((w) => w.reason === ocf) ?? terms?.defaultTerminationWindows.find((w) => w.reason === ocf);
    if (window) windows.push(windowJson(window));
  }
  return windows;
}

function optionDetail(state: engine.LedgerState, security: engine.SecurityState, ownIds: ReadonlySet<string>): api.PortalOptionDetail {
  const subtype = security.identity.subtype;
  const exercisable = subtype !== "RSU";
  const split = subtype === "OPTION_ISO" ? engine.isoSplit(state, security.identity.stakeholderId).find((grant) => grant.securityId === security.identity.id) : undefined;
  const portion = (exercise: engine.ExerciseRecord, kind: engine.OptionPortion) =>
    dec(engine.Dec.sum(exercise.portions.filter((entry) => entry.portion === kind).map((entry) => entry.quantity)));
  return {
    family: "EQUITY_COMPENSATION",
    earlyExerciseAllowed: exercisable && security.earlyExercisable,
    // A year the $100K test can't classify yet (no FMV at grant, here or on an earlier grant) is left out, never guessed.
    isoSplit: (split?.years ?? []).filter((year) => year.unclassified.isZero() && year.value !== null).map((year) => ({
      year: year.year,
      firstExercisable: dec(year.shares),
      valueAtGrant: exactDecimal(year.value) ?? year.value!.roundTo(12, "HALF_EVEN").toString(),
      iso: dec(year.iso),
      nso: dec(year.nso),
    })),
    postTerminationPeriods: exercisable ? postTerminationPeriods(state, security) : [],
    // The portions name the tax treatment: an ISO-designated option exercised after the ISO deadline is an NSO portion.
    exercises: [...security.exercises]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((exercise) => ({
        date: exercise.date,
        quantity: dec(exercise.quantity),
        iso: portion(exercise, "ISO"),
        nso: portion(exercise, "NSO"),
        resultingShares: exercise.resultingSecurityIds
          .map((id) => ownLot(state, id, ownIds))
          .filter((lot): lot is engine.SecurityState => lot !== null)
          .map((lot) => ({ displayId: lot.identity.displayId })),
      })),
  };
}

function periodJson(period: engine.Period): api.Period {
  return { period: String(period.period), unit: period.period_type };
}

/**
 * The company's right to buy back unvested shares (restricted stock): null when the lot carries none or has nothing
 * unvested left. The window is the lot's own, else the plan default; once the holder has left, the last day and its
 * status follow the Securities Status queue's rule, as of the view's date.
 */
function repurchaseJson(state: engine.LedgerState, security: engine.SecurityState): api.PortalShareDetail["repurchase"] {
  const right = security.repurchaseRight;
  if (!engine.hasVestingSchedule(security) && right === null) return null;
  if (!engine.positionAt(state, security, state.asOf).unvestedOutstanding.isPositive()) return null;
  const at = security.termination?.date ?? state.asOf;
  const window = right?.window ?? engine.planTermsOn(state, security.identity.stockPlanId, at)?.defaultRepurchaseWindow ?? null;
  if (security.termination === null) return { price: decOrNull(right?.pricePerShare ?? null), window: window ? periodJson(window) : null, lastDate: null, status: null };
  const lastDate = engine.repurchaseDeadline(state, security);
  const status = lastDate === null ? "not_recorded" : state.asOf > lastDate ? "lapsed" : engine.daysBetween(state.asOf, lastDate) <= 30 ? "closing_soon" : "open";
  return { price: decOrNull(right?.pricePerShare ?? null), window: window ? periodJson(window) : null, lastDate, status };
}

async function shareDetail(ctx: ReadContext, state: engine.LedgerState, security: engine.SecurityState, ownIds: ReadonlySet<string>): Promise<api.PortalShareDetail> {
  const id = security.identity.id;
  const terms = securityTermsOf(ctx, state, security);
  const [certificates, elections] = await ctx.db.batch([
    ctx.db.prepare("SELECT status FROM certificates WHERE org_id = ? AND security_id = ? AND status <> 'VOID' LIMIT 1").bind(ctx.org.id, id),
    // The election in force: the latest record no later record supersedes.
    ctx.db.prepare(
      `SELECT status, filed_date FROM election_83b_records r WHERE r.org_id = ?1 AND r.security_id = ?2
         AND NOT EXISTS (SELECT 1 FROM election_83b_records n WHERE n.org_id = r.org_id AND n.supersedes_id = r.id)
       ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    ).bind(ctx.org.id, id),
  ]);
  const certificated = ((certificates?.results ?? []) as unknown[]).length > 0;
  const election = ((elections?.results ?? []) as { status: api.Election83b["status"]; filed_date: string | null }[])[0];
  const kind = security.origin ? ORIGIN_KINDS[security.origin] : undefined;
  const source = ownLot(state, security.sourceSecurityId ?? security.identity.parentSecurityId, ownIds);
  return {
    family: "STOCK",
    pricePerShare: decOrNull(security.sharePrice),
    // Certificates are imported, unsigned records. Imported lots without one are
    // uncertificated; lots recorded in the app are book entries (the product rules).
    form: certificated ? "migrated_unsigned_certificate" : importedFromPulley(ctx, security) ? "uncertificated" : "book_entry",
    legends: (await legendsOf(ctx, security, terms)).map((legend) => legend.name),
    election83b: election ? { status: election.status, filedOn: election.filed_date } : null,
    repurchase: repurchaseJson(state, security),
    origin: kind ? { kind, from: source?.identity.displayId ?? null } : null,
  };
}

function safeDetail(ctx: ReadContext, state: engine.LedgerState, security: engine.SecurityState, ownIds: ReadonlySet<string>): api.PortalSafeDetail {
  const recorded = (securityTermsOf(ctx, state, security).x_safe_terms ?? {}) as {
    form?: string; valuation_cap?: { amount: string } | null; uncapped?: boolean; discount_rate?: string | null;
  };
  // The shares it converted into that the caller holds (the same lots `convertedInto` names).
  const lots = security.resultingSecurityIds
    .map((id) => ownLot(state, id, ownIds))
    .filter((lot): lot is engine.SecurityState => lot !== null && lot.identity.family === "STOCK");
  const conversion = state.applied.find((tx) => tx.type === "TX_CONVERTIBLE_CONVERSION" && tx.payload.security_id === security.identity.id);
  const className = lots[0] ? classNameOf(state, lots[0]) : null;
  return {
    family: "CONVERTIBLE",
    principal: dec(security.issuedQuantity),
    terms: {
      form: recorded.form ?? null,
      valuationCap: recorded.uncapped === true ? null : (recorded.valuation_cap?.amount ?? null),
      discountRate: recorded.discount_rate ?? null,
    },
    conversion: conversion && className !== null
      ? { date: conversion.effectiveDate, quantity: dec(engine.Dec.sum(lots.map((lot) => lot.issuedQuantity))), className }
      : null,
  };
}

async function holdingDetail(ctx: ReadContext, state: engine.LedgerState, security: engine.SecurityState, ownIds: ReadonlySet<string>): Promise<api.PortalSecurityDetail["detail"]> {
  switch (security.identity.family) {
    case "EQUITY_COMPENSATION":
      return optionDetail(state, security, ownIds);
    case "STOCK":
      return shareDetail(ctx, state, security, ownIds);
    case "WARRANT":
      return { family: "WARRANT" };
    case "CONVERTIBLE":
      return safeDetail(ctx, state, security, ownIds);
  }
}

/** One of `ownIds`' securities with its holding detail, or 404: the holder's page and the admin's preview of it. */
async function holdingDetailFor(ctx: ReadContext, ownIds: ReadonlySet<string>, securityId: string, query: { asOf?: string | undefined }): Promise<api.PortalSecurityDetail> {
  const state = replayed(ctx, holdingsView(ctx, query));
  const security = state.securities.get(securityId);
  if (!security || !ownIds.has(security.identity.stakeholderId)) throw notFound();
  const documents = await holderDocuments(ctx, ownIds, [securityId]);
  const json = portalSecurityJson(ctx, state, security, ownIds, documents);
  if (!json) throw notFound();
  return api.portalSecurityDetailSchema.parse({ ...json, detail: await holdingDetail(ctx, state, security, ownIds) });
}

async function holdingFor(ctx: ReadContext, state: engine.LedgerState, match: { stakeholderId: string; stakeholderName: string }, ownIds: ReadonlySet<string>): Promise<api.PortalHolding> {
  const own = (state.securitiesByStakeholder.get(match.stakeholderId) ?? []).filter((security) => security.issued && !security.retracted);
  const documents = await holderDocuments(ctx, ownIds, own.map((security) => security.identity.id));
  const securities = own
    .map((security) => portalSecurityJson(ctx, state, security, ownIds, documents))
    .filter((security): security is api.PortalSecurity => security !== null);
  return { orgId: ctx.org.id, orgDisplayName: ctx.org.display_name, stakeholderId: match.stakeholderId, stakeholderName: match.stakeholderName, securities };
}

// ---------------------------------------------------------------------------
// How to exercise

/**
 * A company resource the org designates for every holder (the notice of exercise, the privacy notice): a document of
 * this org that the portal lists as a company resource (holder-visible, published, unarchived, linked to no holder,
 * never migration evidence), or null.
 */
async function designatedCompanyResource(ctx: ReadContext, documentId: string | null): Promise<api.PortalDocument | null> {
  if (documentId === null) return null;
  const [document] = await listHolderDocuments(ctx.db, ctx.org.id, new Set(), { documentId });
  return document?.scope === "company" ? document : null;
}

async function howToExerciseFor(ctx: ReadContext, options: { maskAccounts: boolean }): Promise<api.HowToExercise> {
  const portal = ctx.settings.portal;
  const active = await ctx.db.prepare(
    "SELECT details FROM payment_instructions WHERE org_id = ?",
  ).bind(ctx.org.id).first<{ details: string }>();
  let paymentInstructions: api.HowToExercise["paymentInstructions"] = null;
  if (active) {
    paymentInstructions = parsePaymentInstructionDetails(active.details);
  }
  if (paymentInstructions !== null && options.maskAccounts) {
    // Read-only administrator views may mask account and IBAN values; routing and SWIFT stay.
    paymentInstructions = maskPaymentInstructionDetails(paymentInstructions);
  }
  const contact = ctx.settings.companyContact;
  return api.howToExerciseSchema.parse({
    text: portal.howToExerciseText ?? DEFAULT_HOW_TO_EXERCISE,
    noticeForm: await designatedCompanyResource(ctx, portal.noticeFormDocumentId),
    privacyNotice: await designatedCompanyResource(ctx, portal.privacyNoticeDocumentId),
    paymentInstructions,
    companyContact: contact ? { name: contact.name, email: contact.email } : null,
  });
}

// ---------------------------------------------------------------------------
// The holder's routes (the API contract)

/** `GET /api/portal/overview`: every matched record of the caller, across orgs. */
export async function portalOverview(db: D1Database, config: AppConfig | null, matches: readonly PortalMatch[], query: { asOf?: string | undefined }, now: number): Promise<api.PortalOverview> {
  const holdings: api.PortalHolding[] = [];
  let asOf: string | null = query.asOf ?? null;
  for (const orgId of [...new Set(matches.map((match) => match.orgId))]) {
    const ctx = await loadReadContext(db, config, orgId, HOLDER_VIEWER, now);
    const state = replayed(ctx, holdingsView(ctx, query));
    asOf ??= state.asOf;
    const ownIds = new Set(matches.filter((match) => match.orgId === orgId).map((match) => match.stakeholderId));
    for (const match of matches.filter((m) => m.orgId === orgId)) holdings.push(await holdingFor(ctx, state, match, ownIds));
  }
  return api.portalOverviewSchema.parse({ asOf: asOf ?? new Date(now).toISOString().slice(0, 10), holdings });
}

/** `GET /api/portal/orgs/:orgId/securities/:id`: one of the caller's own securities with its holding detail, or 404. */
export async function portalSecurity(db: D1Database, config: AppConfig | null, matches: readonly PortalMatch[], orgId: string, securityId: string, query: { asOf?: string | undefined }, now: number): Promise<api.PortalSecurityDetail> {
  const ownIds = new Set(matches.filter((match) => match.orgId === orgId).map((match) => match.stakeholderId));
  if (ownIds.size === 0) throw notFound();
  const ctx = await loadReadContext(db, config, orgId, HOLDER_VIEWER, now);
  return holdingDetailFor(ctx, ownIds, securityId, query);
}

/** `GET /api/portal/orgs/:orgId/how-to-exercise`: the text, counsel's notice form and privacy notice, the active payment instructions, the contact. */
export async function howToExercise(db: D1Database, config: AppConfig | null, matches: readonly PortalMatch[], orgId: string, now: number): Promise<api.HowToExercise> {
  if (!matches.some((match) => match.orgId === orgId)) throw notFound();
  const ctx = await loadReadContext(db, config, orgId, HOLDER_VIEWER, now);
  return howToExerciseFor(ctx, { maskAccounts: false });
}

// ---------------------------------------------------------------------------
// "Preview as stakeholder" (the API contract): every portal page as that stakeholder would get it in this org

async function previewedStakeholder(ctx: ReadContext, stakeholderId: string): Promise<{ id: string; display_name: string }> {
  const row = await ctx.db.prepare("SELECT id, display_name FROM stakeholders WHERE org_id = ? AND id = ?").bind(ctx.org.id, stakeholderId).first<{ id: string; display_name: string }>();
  if (!row) throw notFound("Stakeholder not found");
  return row;
}

/** `GET …/stakeholders/:id/preview`: exactly the overview that stakeholder would get in this org. */
export async function previewAsStakeholder(ctx: ReadContext, stakeholderId: string, query: { asOf?: string | undefined }): Promise<api.PortalOverview> {
  const row = await previewedStakeholder(ctx, stakeholderId);
  const state = replayed(ctx, holdingsView(ctx, query));
  const holding = await holdingFor(ctx, state, { stakeholderId, stakeholderName: row.display_name }, new Set([stakeholderId]));
  return api.portalOverviewSchema.parse({ asOf: state.asOf, holdings: [holding] });
}

/** `GET …/stakeholders/:id/preview/securities/:securityId`: exactly that stakeholder's holding detail, or 404. */
export async function previewPortalSecurity(ctx: ReadContext, stakeholderId: string, securityId: string, query: { asOf?: string | undefined }): Promise<api.PortalSecurityDetail> {
  await previewedStakeholder(ctx, stakeholderId);
  return holdingDetailFor(ctx, new Set([stakeholderId]), securityId, query);
}

/** `GET …/stakeholders/:id/preview/documents`: the portal's own document list (the portal UI's) for that stakeholder. */
export async function previewPortalDocuments(ctx: ReadContext, stakeholderId: string): Promise<api.PortalDocumentList> {
  await previewedStakeholder(ctx, stakeholderId);
  return api.portalDocumentListSchema.parse(await listHolderDocuments(ctx.db, ctx.org.id, new Set([stakeholderId])));
}

/**
 * `GET …/stakeholders/:id/preview/how-to-exercise`: the page that stakeholder would get. It is an admin view, so the
 * account number and IBAN are masked when PII is unavailable; nothing else on it is personal data.
 */
export async function previewHowToExercise(ctx: ReadContext, stakeholderId: string): Promise<api.HowToExercise> {
  await previewedStakeholder(ctx, stakeholderId);
  return howToExerciseFor(ctx, { maskAccounts: !ctx.viewer.fullAccess });
}
