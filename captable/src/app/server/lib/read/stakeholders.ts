import { api, engine } from "#shared";
import { notFound } from "../http.ts";
import { dec, echo, email, exactDecimal, ratio, type ReadContext } from "./context.ts";
import { exerciseRecords } from "./records.ts";
import { securityJson, securityLookups } from "./securities.ts";

/**
 * Stakeholder views: profile, e-mails, the computed portal
 * state, the ledger's termination and leaves, and holdings totals as of a date. Personal data is masked for
 * read-only admins outside `readOnlyPii`.
 */

export interface StakeholderRow {
  id: string;
  kind: "individual" | "institution";
  display_name: string;
  legal_name: string | null;
  relationship: api.Stakeholder["relationship"];
  issuer_assigned_id: string | null;
  address: string | null;
  phone: string | null;
  country_of_residence: string | null;
  tax_status: "us" | "non_us" | "unknown";
  hire_date: string | null;
  comments: string | null;
  portal_access: "auto" | "open" | "closed";
  outside_counsel: number;
  archived_at: number | null;
  merged_into_id: string | null;
  merged_by_command_id: string | null;
  version: number;
  pulley_id: string | null;
}

export interface EmailRow {
  id: string;
  stakeholder_id: string;
  email: string;
  kind: "self" | "contact" | "representative";
  contact_name: string | null;
  contact_role: string | null;
  authorizing_document_id: string | null;
  added_by: string | null;
  created_at: number;
  removed_at: number | null;
}

export interface StakeholderRows {
  stakeholders: StakeholderRow[];
  emails: Map<string, EmailRow[]>;
  scheduled: Map<string, { id: string; terminationDate: string; type: engine.TerminationType }>;
  addedBy: Map<string, string>;
  names: Map<string, string>;
  mergedRecords: Map<string, { id: string; displayName: string; commandId: string }[]>;
}

export async function stakeholderRows(ctx: ReadContext, stakeholderId?: string): Promise<StakeholderRows> {
  const [stakeholders, emails, scheduled, users, mergeRows] = await ctx.db.batch([
    ctx.db.prepare("SELECT * FROM stakeholders WHERE org_id = ?1 AND ((?2 IS NULL AND archived_at IS NULL) OR id = ?2) ORDER BY display_name, id").bind(ctx.org.id, stakeholderId ?? null),
    ctx.db.prepare("SELECT * FROM stakeholder_emails WHERE org_id = ?1 AND (?2 IS NULL OR stakeholder_id = ?2) ORDER BY created_at, id").bind(ctx.org.id, stakeholderId ?? null),
    ctx.db.prepare("SELECT id, stakeholder_id, termination_date, termination_type FROM scheduled_terminations WHERE org_id = ? AND status = 'SCHEDULED'").bind(ctx.org.id),
    ctx.db.prepare("SELECT u.id, u.email, u.display_name FROM users u WHERE u.id IN (SELECT added_by FROM stakeholder_emails WHERE org_id = ? AND added_by IS NOT NULL)").bind(ctx.org.id),
    ctx.db.prepare("SELECT id, display_name, merged_into_id, merged_by_command_id FROM stakeholders WHERE org_id = ?").bind(ctx.org.id),
  ]);
  const byStakeholder = new Map<string, EmailRow[]>();
  for (const row of (emails?.results ?? []) as EmailRow[]) byStakeholder.set(row.stakeholder_id, [...(byStakeholder.get(row.stakeholder_id) ?? []), row]);
  const scheduledMap = new Map<string, { id: string; terminationDate: string; type: engine.TerminationType }>();
  for (const row of (scheduled?.results ?? []) as { id: string; stakeholder_id: string; termination_date: string; termination_type: engine.TerminationType }[]) {
    scheduledMap.set(row.stakeholder_id, { id: row.id, terminationDate: row.termination_date, type: row.termination_type });
  }
  const addedBy = new Map<string, string>();
  for (const row of (users?.results ?? []) as { id: string; email: string | null; display_name: string | null }[]) {
    addedBy.set(row.id, row.display_name ?? row.email ?? row.id);
  }
  const names = new Map<string, string>();
  const mergedRecords = new Map<string, { id: string; displayName: string; commandId: string }[]>();
  for (const row of (mergeRows?.results ?? []) as { id: string; display_name: string; merged_into_id: string | null; merged_by_command_id: string | null }[]) {
    names.set(row.id, row.display_name);
    if (row.merged_into_id !== null && row.merged_by_command_id !== null) {
      mergedRecords.set(row.merged_into_id, [...(mergedRecords.get(row.merged_into_id) ?? []), { id: row.id, displayName: row.display_name, commandId: row.merged_by_command_id }]);
    }
  }
  return { stakeholders: (stakeholders?.results ?? []) as StakeholderRow[], emails: byStakeholder, scheduled: scheduledMap, addedBy, names, mergedRecords };
}

function parseAddress(text: string | null): api.Address | null {
  if (text === null) return null;
  try {
    const parsed = api.addressSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function portalState(row: StakeholderRow, emails: readonly EmailRow[]): api.Stakeholder["portalState"] {
  if (row.portal_access === "closed") return "closed_by_admin";
  const hasSelfEmail = emails.some((e) => e.removed_at === null && e.kind === "self");
  return hasSelfEmail ? "open" : "no_self_email";
}

function emailJson(ctx: ReadContext, row: EmailRow, addedBy: Map<string, string>): api.StakeholderEmail {
  return {
    id: row.id,
    email: email(ctx, row.email),
    kind: row.kind,
    contactName: row.contact_name,
    contactRole: row.contact_role,
    authorizingDocumentId: row.authorizing_document_id,
    addedBy: row.added_by === null ? null : (addedBy.get(row.added_by) ?? null),
    createdAt: row.created_at,
    removedAt: row.removed_at,
  };
}

export function stakeholderJson(
  ctx: ReadContext,
  row: StakeholderRow,
  rows: StakeholderRows,
  state: engine.LedgerState,
  todayState: engine.LedgerState,
  holder: engine.HolderMetrics | undefined,
): api.Stakeholder {
  const emails = rows.emails.get(row.id) ?? [];
  const engineHolder = state.stakeholders.get(row.id);
  const termination = engineHolder?.terminations[engineHolder.terminations.length - 1] ?? null;
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    legalName: row.legal_name,
    relationship: row.relationship,
    issuerAssignedId: row.issuer_assigned_id,
    address: ctx.viewer.pii ? parseAddress(row.address) : null,
    phone: ctx.viewer.pii ? row.phone : null,
    countryOfResidence: row.country_of_residence,
    taxStatus: row.tax_status,
    hireDate: row.hire_date,
    comments: row.comments,
    portalAccess: row.portal_access,
    mergedInto: row.merged_into_id === null || row.merged_by_command_id === null ? null : {
      id: row.merged_into_id,
      displayName: rows.names.get(row.merged_into_id) ?? row.merged_into_id,
      commandId: row.merged_by_command_id,
    },
    mergedRecords: rows.mergedRecords.get(row.id) ?? [],
    portalState: portalState(row, emails),
    termination: termination === null ? null : { date: termination.date, type: termination.type, vestingStopDate: termination.vestingStopDate, commandId: termination.commandId },
    scheduledTermination: rows.scheduled.get(row.id) ?? null,
    leaveOfAbsence: (engineHolder?.leaves ?? []).map((leave) => ({ startDate: leave.startDate, endDate: leave.endDate, returnGuaranteed: leave.returnGuaranteed })),
    emails: emails.map((e) => emailJson(ctx, e, rows.addedBy)),
    totals: {
      issuedAndOutstanding: dec(holder?.stockOutstanding),
      fullyDiluted: dec(holder?.fullyDiluted),
      fullyDilutedPct: holder ? ratio(holder.fullyDilutedPct) : "0",
      capitalContribution: dec(holder?.capitalContribution),
    },
    provenance: { importedFromPulley: row.pulley_id !== null, pulleyId: ctx.viewer.fullAccess ? row.pulley_id : null },
    version: row.version,
  };
}

export async function stakeholderList(ctx: ReadContext, state: engine.LedgerState, todayState: engine.LedgerState): Promise<api.StakeholderList> {
  const rows = await stakeholderRows(ctx);
  const holders = new Map(engine.computeMetrics(state).holders.map((holder) => [holder.stakeholderId, holder]));
  return {
    ...echo(ctx, state),
    items: rows.stakeholders.map((row) => stakeholderJson(ctx, row, rows, state, todayState, holders.get(row.id))),
  };
}

export async function stakeholderDetail(ctx: ReadContext, state: engine.LedgerState, todayState: engine.LedgerState, stakeholderId: string): Promise<api.StakeholderDetail> {
  const rows = await stakeholderRows(ctx, stakeholderId);
  const row = rows.stakeholders[0];
  if (!row) throw notFound("Stakeholder not found");
  const holder = engine.computeMetrics(state).holders.find((h) => h.stakeholderId === stakeholderId);
  return api.stakeholderDetailSchema.parse({
    ...stakeholderJson(ctx, row, rows, state, todayState, holder),
    ...echo(ctx, state),
    exercises: await exerciseRecords(ctx, todayState, { stakeholderId }),
  });
}

export async function stakeholderOr404(ctx: ReadContext, stakeholderId: string): Promise<void> {
  const row = await ctx.db.prepare("SELECT id FROM stakeholders WHERE org_id = ? AND id = ?").bind(ctx.org.id, stakeholderId).first();
  if (!row) throw notFound("Stakeholder not found");
}

export async function stakeholderHoldings(ctx: ReadContext, state: engine.LedgerState, stakeholderId: string): Promise<api.StakeholderHoldings> {
  await stakeholderOr404(ctx, stakeholderId);
  const lookups = await securityLookups(ctx, state);
  const metrics = engine.computeMetrics(state);
  const numbers = new Map(metrics.securities.map((n) => [n.securityId, n]));
  const items = (state.securitiesByStakeholder.get(stakeholderId) ?? [])
    .filter((security) => security.issued)
    .map((security) => securityJson(ctx, state, security, numbers.get(security.identity.id)!, lookups));
  return { ...echo(ctx, state), items };
}

/** ISO/NSO lots by year (the ledger rules), with the lots each grant's exercises consumed, ISO lots first by year. */
export async function isoSplitView(ctx: ReadContext, state: engine.LedgerState, stakeholderId: string): Promise<api.IsoSplit> {
  await stakeholderOr404(ctx, stakeholderId);
  const years = new Map<number, { used: engine.Rational; lots: api.IsoSplit["years"][number]["lots"] }>();
  for (const grant of engine.isoSplit(state, stakeholderId)) {
    const security = state.securities.get(grant.securityId);
    let isoLeft = engine.Dec.sum((security?.exercises ?? []).map((e) => e.lotsConsumed.iso));
    let nsoLeft = engine.Dec.sum((security?.exercises ?? []).map((e) => e.lotsConsumed.nso));
    for (const lot of grant.years) {
      const exercisedIso = engine.Dec.min(isoLeft, lot.iso);
      const exercisedNso = engine.Dec.min(nsoLeft, lot.nso);
      isoLeft = isoLeft.sub(exercisedIso);
      nsoLeft = nsoLeft.sub(exercisedNso);
      const entry = years.get(lot.year) ?? { used: engine.Rational.ZERO, lots: [] };
      if (grant.fmv !== null) entry.used = entry.used.add(engine.Rational.fromDec(lot.iso).mul(grant.fmv));
      entry.lots.push({
        securityId: grant.securityId,
        displayId: grant.displayId,
        fmvAtGrant: exactDecimal(grant.fmv) ?? "0",
        isoQuantity: dec(lot.iso),
        nsoQuantity: dec(lot.nso),
        exercisedIso: dec(exercisedIso),
        exercisedNso: dec(exercisedNso),
      });
      years.set(lot.year, entry);
    }
  }
  return api.isoSplitSchema.parse({
    stakeholderId,
    years: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, entry]) => ({
      year,
      isoValueUsed: exactDecimal(entry.used) ?? entry.used.roundTo(12, "HALF_EVEN").toString(),
      lots: entry.lots,
    })),
  });
}
