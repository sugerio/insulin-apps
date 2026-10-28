import { api, type engine } from "#shared";
import { capTable, dashboard, securitiesStatus } from "./captable.ts";
import { echo, holdingsView, replayed, type ReadContext } from "./context.ts";
import { previewAsStakeholder, previewHowToExercise, previewPortalDocuments, previewPortalSecurity } from "./portal.ts";
import {
  ActorLabels,
  auditPage,
  certificates,
  commandDetail,
  elections83b,
  exerciseRecords,
  exerciseRequest,
  exerciseRequests,
  legends,
  signatureRequests,
  transactionDetail,
  transactionPage,
} from "./records.ts";
import { securityDetail, securityList, securityLookups, securityTerminationPreview, securityTimeline, securityVesting } from "./securities.ts";
import { isoSplitView, stakeholderDetail, stakeholderHoldings, stakeholderList } from "./stakeholders.ts";
import { previewVesting, stockClassDetail, stockClassList, stockPlanDetail, stockPlanList, vestingTermsDetail, vestingTermsList } from "./structure.ts";
import { signatoryList } from "./orgs.ts";
import { expiryRunDetail, expiryRunList } from "./expiry-runs.ts";
import { fmvLookup, valuationDetail, valuationList } from "./valuations.ts";

/**
 * The admin read endpoints as data: one handler per route id of the contract, shared by the HTTP routes.
 */
export interface ReadInput {
  params: Record<string, string>;
  /** The query, parsed with the route's own schema. */
  query: Record<string, unknown>;
  /** A JSON body, parsed with the route's own schema (vesting preview only). */
  body?: unknown;
}

export type ReadHandler = (ctx: ReadContext, input: ReadInput) => Promise<unknown>;

const today = (ctx: ReadContext) => replayed(ctx, { asOf: ctx.today, asKnownAt: null });
const view = (ctx: ReadContext, query: Record<string, unknown>) => replayed(ctx, holdingsView(ctx, query as { asOf?: string; asKnownAt?: number }));

export const READ_HANDLERS: Record<string, ReadHandler> = {
  getDashboard: async (ctx) => dashboard(ctx, today(ctx)),
  getCapTable: async (ctx, { query }) => capTable(ctx, view(ctx, query), (query.tab as "ownership" | undefined) ?? "ownership"),
  getSecuritiesStatus: async (ctx) => securitiesStatus(ctx, today(ctx)),
  listSecurities: async (ctx, { query }) => {
    const state = view(ctx, query);
    return { ...echo(ctx, state), items: securityList(ctx, state, await securityLookups(ctx, state), query.family as engine.SecurityFamily | undefined) };
  },
  getSecurity: async (ctx, { params, query }) => securityDetail(ctx, view(ctx, query), params.id!),
  getSecurityVesting: async (ctx, { params, query }) => securityVesting(ctx, view(ctx, { asOf: query.asOf }), params.id!),
  getSecurityTimeline: async (ctx, { params }) => {
    const labels = new ActorLabels(ctx);
    return { items: await securityTimeline(ctx, today(ctx), params.id!, (commandId) => labels.command(commandId)) };
  },
  getTerminationPreview: async (ctx, { params, query }) =>
    securityTerminationPreview(today(ctx), params.id!, query as { terminationDate: string; terminationType: engine.TerminationType; vestingStopDate?: string }),
  listStakeholders: async (ctx, { query }) => stakeholderList(ctx, view(ctx, { asOf: query.asOf }), today(ctx)),
  getStakeholder: async (ctx, { params, query }) => stakeholderDetail(ctx, view(ctx, { asOf: query.asOf }), today(ctx), params.id!),
  getStakeholderHoldings: async (ctx, { params, query }) => stakeholderHoldings(ctx, view(ctx, query), params.id!),
  previewAsStakeholder: async (ctx, { params, query }) => previewAsStakeholder(ctx, params.id!, query as { asOf?: string }),
  previewPortalSecurity: async (ctx, { params, query }) => previewPortalSecurity(ctx, params.id!, params.securityId!, query as { asOf?: string }),
  previewPortalDocuments: async (ctx, { params }) => previewPortalDocuments(ctx, params.id!),
  previewHowToExercise: async (ctx, { params }) => previewHowToExercise(ctx, params.id!),
  getIsoSplit: async (ctx, { params }) => isoSplitView(ctx, today(ctx), params.id!),
  listStockClasses: async (ctx, { query }) => stockClassList(ctx, view(ctx, query)),
  getStockClass: async (ctx, { params, query }) => stockClassDetail(ctx, view(ctx, query), params.id!),
  listStockPlans: async (ctx, { query }) => stockPlanList(ctx, view(ctx, query)),
  getStockPlan: async (ctx, { params, query }) => stockPlanDetail(ctx, view(ctx, query), params.id!),
  listVestingTerms: async (ctx, { query }) => vestingTermsList(ctx, today(ctx), query.templates === true),
  getVestingTerms: async (ctx, { params }) => vestingTermsDetail(ctx, today(ctx), params.id!),
  previewVesting: async (ctx, { body }) => previewVesting(ctx, body as api.VestingPreviewRequest),
  listValuations: async (ctx) => valuationList(ctx),
  getValuation: async (ctx, { params }) => valuationDetail(ctx, today(ctx), params.id!),
  getFmv: async (ctx, { query }) => fmvLookup(ctx, today(ctx), query as { date: string; stockClassId?: string }),
  listExpiryRuns: async (ctx) => expiryRunList(ctx),
  getExpiryRun: async (ctx, { params }) => expiryRunDetail(ctx, Number(params.runId)),
  listTransactions: async (ctx, { query }) => transactionPage(ctx, query as unknown as Parameters<typeof transactionPage>[1]),
  getTransaction: async (ctx, { params }) => transactionDetail(ctx, params.id!),
  getCommand: async (ctx, { params }) => commandDetail(ctx, params.id!),
  listExercises: async (ctx, { query }) => ({ items: await exerciseRecords(ctx, today(ctx), { year: query.year as number | undefined }) }),
  listExerciseRequests: async (ctx) => ({ items: await exerciseRequests(ctx, today(ctx)) }),
  getExerciseRequest: async (ctx, { params }) => exerciseRequest(ctx, today(ctx), params.id!),
  listSignatureRequests: async (ctx, { query }) => ({ items: await signatureRequests(ctx, query.securityId as string | undefined) }),
  listCertificates: async (ctx) => ({ items: await certificates(ctx) }),
  listLegends: async (ctx) => ({ items: await legends(ctx, "LEGEND") }),
  listCertificateTerms: async (ctx) => ({ items: await legends(ctx, "CERTIFICATE_TERMS") }),
  listElections83b: async (ctx, { query }) => ({ items: await elections83b(ctx, query.securityId as string | undefined) }),
  listOrgAudit: async (ctx, { query }) => auditPage(ctx, query as unknown as Parameters<typeof auditPage>[1]),
  listSignatories: async (ctx) => signatoryList(ctx.db, ctx.org.id),
};

/** The response schema a read handler's answer must satisfy. */
export function responseSchemaOf(routeId: string) {
  const route = api.routeById(routeId);
  if (!route || route.response.kind !== "json") throw new Error(`No JSON route ${routeId}`);
  return route.response.schema;
}
