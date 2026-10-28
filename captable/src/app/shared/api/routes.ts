import "./zod-config.ts";
import { z } from "zod";
import { ledgerVerificationSchema } from "./admin.ts";
import { meResponseSchema } from "./auth.ts";
import {
  COMMANDS,
  type CommandSpec,
  commandQuerySchema,
  confirmExpiryRunDryRunSchema,
  confirmExpiryRunResponseSchema,
  confirmExpiryRunSchema,
  expiryRunDetailSchema,
  expiryRunListSchema,
  reversalPreviewSchema,
} from "./commands.ts";
import {
  addDocumentLinkRequestSchema,
  createCollectionRequestSchema,
  documentCollectionListSchema,
  documentCollectionSchema,
  documentDetailSchema,
  documentListQuerySchema,
  documentPageSchema,
  documentSchema,
  holderVisibilityRequestSchema,
  patchCollectionRequestSchema,
  patchDocumentRequestSchema,
  revokeLinkRequestSchema,
} from "./documents.ts";
import {
  type CommandName,
  DOCUMENT_CONTENT_TYPES,
  type OrgAccess,
  reportKeySchema,
} from "./enums.ts";
import {
  emptyRequestSchema,
  stockClassDetailSchema,
  stockClassListSchema,
  stockPlanDetailSchema,
  stockPlanListSchema,
  vestingPreviewRequestSchema,
  vestingPreviewResponseSchema,
  vestingTermsListSchema,
  vestingTermsQuerySchema,
  vestingTermsSchema,
} from "./equity.ts";
import { API_ERROR_CODES, type ApiErrorCode } from "./errors.ts";
import {
  auditPageSchema,
  capTableQuerySchema,
  capTableResponseSchema,
  certificateListSchema,
  commandDetailSchema,
  dashboardResponseSchema,
  election83bListSchema,
  exerciseListSchema,
  exerciseRequestListSchema,
  exerciseRequestSchema,
  exercisesQuerySchema,
  isoSplitSchema,
  legendListSchema,
  orgAuditQuerySchema,
  securitiesStatusSchema,
  securityDetailSchema,
  securityFilterQuerySchema,
  securityListQuerySchema,
  securityListSchema,
  securityTimelineSchema,
  securityVestingSchema,
  signatureRequestListSchema,
  terminationPreviewQuerySchema,
  terminationPreviewSchema,
  transactionDetailSchema,
  transactionListQuerySchema,
  transactionPageSchema,
} from "./holdings.ts";
import { downloadResponseHeadersSchema, exportResponseHeadersSchema, LIMITS, uploadHeadersSchema } from "./http.ts";
import {
  IMPORT_LIMITS,
  importCommitFormSchema,
  importCommitResponseSchema,
  importPreviewFormSchema,
  importPreviewResponseSchema,
  importRunSchema,
} from "./imports.ts";
import {
  adminStakeholderLinkListSchema,
  adminStakeholderLinkSchema,
  createAdminLinkRequestSchema,
  createOrgRequestSchema,
  orgListSchema,
  orgSchema,
  orgSignatoryListSchema,
  patchOrgRequestSchema,
  paymentInstructionSchema,
  reasonRequestSchema,
  setPaymentInstructionsRequestSchema,
} from "./orgs.ts";
import { howToExerciseSchema, portalDocumentListSchema, portalOverviewSchema, portalSecurityDetailSchema } from "./portal/schemas.ts";
import { asOfQuerySchema, holdingsQuerySchema, pageQuerySchema, uuidSchema } from "./primitives.ts";
import { REPORT_CONTENT_TYPES, reportJsonSchema, reportQuerySchema } from "./reports.ts";
import {
  createStakeholderRequestSchema,
  patchStakeholderRequestSchema,
  removeStakeholderEmailRequestSchema,
  addStakeholderEmailRequestSchema,
  stakeholderEmailSchema,
  stakeholderDetailSchema,
  stakeholderHoldingsSchema,
  stakeholderListSchema,
  stakeholderSchema,
} from "./stakeholders.ts";
import {
  fmvQuerySchema,
  fmvResponseSchema,
  materialEventRequestSchema,
  recordValuationRequestSchema,
  reverseValuationEventRequestSchema,
  reviewClearedRequestSchema,
  valuationDetailSchema,
  valuationListSchema,
  valuationSchema,
  voidValuationRequestSchema,
} from "./valuations.ts";

// The route table: every current endpoint as data, for the Worker (validation, authorization, idempotency,
// response checks) and the SPA (paths, typed requests and responses). `routes` is keyed by route id; `ROUTE_TABLE` is
// the ordered list, literal paths before overlapping parameter paths so a first-match router never shadows one.

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Who may call a route: identity for any console user, admin for OWNER/ADMIN/EDITOR
 * according to `access`, and holder for USER/VIEWER records matched by their console e-mail.
 */
export const AUTH_CLASSES = ["identity", "admin", "holder"] as const;
export type AuthClass = (typeof AUTH_CLASSES)[number];

/** Idempotency-Key (the API contract): required on mutating `/api/*` requests, except dry runs and pure previews. */
export type Idempotency = "required" | "required_unless_dry_run" | "none";

export interface NoBody {
  readonly kind: "none";
}
/** A JSON body, parsed with its strict schema. Commands with a dry run validate `?dryRun=true` bodies with `dryRunSchema`. */
export interface JsonBody<S extends z.ZodType = z.ZodType, D extends z.ZodType | undefined = z.ZodType | undefined> {
  readonly kind: "json";
  readonly schema: S;
  readonly dryRunSchema: D;
  readonly maxBytes: number;
}
/** A raw document body described by its headers. */
export interface RawBody<H extends z.ZodType = z.ZodType> {
  readonly kind: "raw";
  readonly headers: H;
  readonly maxBytes: number;
}
/** A multipart/form-data body parsed into fields and uploaded files. */
export interface FormBody<S extends z.ZodType = z.ZodType> {
  readonly kind: "form";
  readonly schema: S;
  readonly maxBytes: number;
}
export type BodySpec = NoBody | JsonBody | RawBody | FormBody;

export interface JsonResponse<S extends z.ZodType = z.ZodType> {
  readonly kind: "json";
  readonly status: 200 | 201 | 202;
  readonly schema: S;
}
export interface EmptyResponse {
  readonly kind: "empty";
  readonly status: 204;
}
/** Streamed bytes (downloads, exports) with the headers they must carry; a JSON export's body follows `jsonSchema`. */
export interface FileResponse {
  readonly kind: "file";
  readonly status: 200;
  readonly contentTypes: readonly string[];
  readonly headers: z.ZodType;
  readonly jsonSchema: z.ZodType | null;
}
export type ResponseSpec = JsonResponse | EmptyResponse | FileResponse;

export interface Route<
  P extends string = string,
  Params extends z.ZodType | null = z.ZodType | null,
  Q extends z.ZodType | null = z.ZodType | null,
  B extends BodySpec = BodySpec,
  R extends ResponseSpec = ResponseSpec,
> {
  readonly id: string;
  readonly method: HttpMethod;
  /** Hono-style pattern. `:orgId` and every id are UUIDs; a segment that doesn't parse answers 404 (the API contract). */
  readonly path: P;
  /** The contract category shown in generated route documentation. */
  readonly section: string;
  readonly summary: string;
  readonly auth: AuthClass;
  /** The effective org roles allowed for admin routes; empty otherwise. */
  readonly access: readonly OrgAccess[];
  /** Permission notes beyond the role: masking, two-person rules, scope. */
  readonly permission: string | null;
  /** Path parameters; a value that fails is 404, not 400. */
  readonly params: Params;
  readonly query: Q;
  readonly body: B;
  readonly response: R;
  readonly idempotency: Idempotency;
  /** The body sends back the optimistic `version` it read (the API contract): 409 stale_version when it moved. */
  readonly version: boolean;
  /** The body carries `expectedLedgerSeq` (and `expectedDiffSha256`): 409 stale_ledger / state_changed. */
  readonly ledgerGuard: boolean;
  /** The body carries a typed confirmation (the API contract). */
  readonly confirmation: boolean;
  /** `?cursor=&limit=` and a `{items, nextCursor}` page (the API contract). */
  readonly pagination: boolean;
  /** Every error code the route may answer with (the API contract). */
  readonly errors: readonly ApiErrorCode[];
  /** The product codes of its 422 invariant_violation and warnings_unacknowledged answers. */
  readonly violations: readonly string[];
  readonly warnings: readonly string[];
}
export type AnyRoute = Route;

// ---------------------------------------------------------------------------
// Path parameters

/** The names of a pattern's `:params`, as a type: "/api/orgs/:orgId/x/:id" → "orgId" | "id". */
export type ParamName<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamName<Rest>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
type ParamsShape<P extends string, O> = {
  [K in ParamName<P>]: K extends keyof O ? (O[K] extends z.ZodType ? O[K] : typeof uuidSchema) : typeof uuidSchema;
};
export type ParamsSchema<P extends string, O> = [ParamName<P>] extends [never] ? null : z.ZodObject<ParamsShape<P, O>, z.core.$strip>;

/** The names of a pattern's `:params`, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]!);
}

function paramsSchemaFor(path: string, overrides: Record<string, z.ZodType>): z.ZodObject | null {
  const names = pathParamNames(path);
  if (names.length === 0) return null;
  return z.object(Object.fromEntries(names.map((name) => [name, overrides[name] ?? uuidSchema])));
}

// ---------------------------------------------------------------------------
// Building routes

export function jsonBody<S extends z.ZodType>(schema: S): JsonBody<S, undefined>;
export function jsonBody<S extends z.ZodType, D extends z.ZodType | undefined>(schema: S, dryRunSchema: D, maxBytes?: number): JsonBody<S, D>;
export function jsonBody(schema: z.ZodType, dryRunSchema?: z.ZodType, maxBytes: number = LIMITS.jsonBodyBytes): JsonBody {
  return { kind: "json", schema, dryRunSchema, maxBytes };
}
const rawBody = <H extends z.ZodType>(headers: H, maxBytes: number): RawBody<H> => ({ kind: "raw", headers, maxBytes });
const formBody = <S extends z.ZodType>(schema: S, maxBytes: number): FormBody<S> => ({ kind: "form", schema, maxBytes });
const json = <S extends z.ZodType>(schema: S, status: 200 | 201 | 202 = 200): JsonResponse<S> => ({ kind: "json", status, schema });
const created = <S extends z.ZodType>(schema: S): JsonResponse<S> => json(schema, 201);
const EMPTY: EmptyResponse = { kind: "empty", status: 204 };
const file = (contentTypes: readonly string[], headers: z.ZodType, jsonSchema: z.ZodType | null = null): FileResponse => ({
  kind: "file",
  status: 200,
  contentTypes,
  headers,
  jsonSchema,
});

const READ_ROLES = ["admin_rw", "admin_ro"] as const satisfies readonly OrgAccess[];
/** the API contract: the portal reveals nothing to a caller it doesn't serve. */
const HOLDER_PERMISSION =
  "The caller's own holdings only. A console user without an e-mail match gets 404 on every portal request";
const WRITE_ROLES = ["admin_rw"] as const satisfies readonly OrgAccess[];

interface RouteInput<P extends string, O, Q, B, R> {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: P;
  readonly section: string;
  readonly summary: string;
  readonly auth: AuthClass;
  readonly access?: readonly OrgAccess[];
  readonly permission?: string;
  /** Path parameters that aren't UUIDs (for example `:reportKey` and `:runId`). */
  readonly params?: O;
  readonly query?: Q;
  readonly body?: B;
  readonly response: R;
  readonly idempotency?: Idempotency;
  readonly version?: boolean;
  readonly ledgerGuard?: boolean;
  readonly confirmation?: boolean;
  readonly pagination?: boolean;
  /** Errors beyond the ones the route's shape implies (see `impliedErrors`). */
  readonly errors?: readonly ApiErrorCode[];
  readonly violations?: readonly string[];
  readonly warnings?: readonly string[];
}

function impliedErrors(route: Omit<Route, "errors">, extra: readonly ApiErrorCode[]): ApiErrorCode[] {
  const codes = new Set<ApiErrorCode>(extra);
  codes.add("internal");
  codes.add("unavailable");
  if (route.query !== null || route.body.kind !== "none") {
    codes.add("validation_failed");
  }
  codes.add("unauthenticated");
  if (route.auth === "admin") codes.add("forbidden");
  if (route.method !== "GET") codes.add("forbidden");
  if (route.params !== null || route.auth === "holder") codes.add("not_found");
  if (route.idempotency !== "none" || route.version || route.ledgerGuard) codes.add("conflict");
  if (route.body.kind !== "none") codes.add("payload_too_large");
  if (route.body.kind === "raw" || route.body.kind === "form") {
    codes.add("unsupported_media_type");
    codes.add("digest_mismatch");
  }
  if (route.violations.length > 0) codes.add("invariant_violation");
  if (route.warnings.length > 0) codes.add("warnings_unacknowledged");
  return API_ERROR_CODES.filter((code) => codes.has(code));
}

function defaultIdempotency(method: HttpMethod, path: string, body: BodySpec): Idempotency {
  if (method === "GET") return "none";
  if (body.kind === "json" && body.dryRunSchema !== undefined) return "required_unless_dry_run";
  return "required";
}

function defaultAccess(auth: AuthClass, method: HttpMethod, id: string): readonly OrgAccess[] {
  if (auth !== "admin") return [];
  if (method === "GET") return READ_ROLES;
  return WRITE_ROLES;
}

/** Fills a route's defaults: UUID path params, idempotency from the method, access, and the implied errors. */
export function defineRoute<
  const P extends string,
  const R extends ResponseSpec,
  const O extends { readonly [K in ParamName<P>]?: z.ZodType } = {},
  const Q extends z.ZodType | null = null,
  const B extends BodySpec = NoBody,
>(input: RouteInput<P, O, Q, B, R>): Route<P, ParamsSchema<P, O>, Q, B, R> {
  const body = (input.body ?? { kind: "none" }) as B;
  const base = {
    id: input.id,
    method: input.method,
    path: input.path,
    section: input.section,
    summary: input.summary,
    auth: input.auth,
    access: input.access ?? defaultAccess(input.auth, input.method, input.id),
    permission: input.permission ?? null,
    params: paramsSchemaFor(input.path, (input.params ?? {}) as Record<string, z.ZodType>) as ParamsSchema<P, O>,
    query: (input.query ?? null) as Q,
    body,
    response: input.response,
    idempotency: input.idempotency ?? defaultIdempotency(input.method, input.path, body),
    version: input.version ?? false,
    ledgerGuard: input.ledgerGuard ?? false,
    confirmation: input.confirmation ?? false,
    pagination: input.pagination ?? false,
    violations: input.violations ?? [],
    warnings: input.warnings ?? [],
  };
  return { ...base, errors: impliedErrors(base, input.errors ?? []) };
}

/** A command's route, from its entry in the command index (the API contract). */
function commandRoute<
  const Name extends CommandName,
  S extends z.ZodType,
  D extends z.ZodType | null,
  Res extends z.ZodType,
>(id: string, spec: CommandSpec & { readonly name: Name; readonly schema: S; readonly dryRunSchema: D; readonly response: Res }) {
  return defineRoute({
    id,
    method: "POST",
    path: `/api/orgs/:orgId/commands/${spec.name}` as `/api/orgs/:orgId/commands/${Name}`,
    section: spec.section,
    summary: spec.summary,
    auth: "admin",
    access: WRITE_ROLES,
    permission: "Never on the administrator's own holdings (403 self_dealing)",
    query: spec.dryRunSchema === null ? null : commandQuerySchema,
    body: jsonBody(spec.schema, (spec.dryRunSchema ?? undefined) as D extends z.ZodType ? D : undefined),
    response: json(spec.response),
    ledgerGuard: spec.ledgerGuard,
    confirmation: spec.confirmation,
    version: spec.name === "cancel-scheduled-termination",
    errors: ["self_dealing"],
    violations: spec.violations,
    warnings: spec.warnings,
  });
}

// ---------------------------------------------------------------------------
// The routes

export const routes = {
  // Routes retained by the Insulin runtime.
  getMe: defineRoute({
    id: "getMe",
    method: "GET",
    path: "/api/me",
    section: "Company setup",
    summary: "Console identity, company access and holder matches",
    auth: "identity",
    response: json(meResponseSchema),
  }),
  listOrgs: defineRoute({
    id: "listOrgs",
    method: "GET",
    path: "/api/orgs",
    section: "Company",
    summary: "The Insulin organization's active company, when one exists",
    auth: "admin",
    permission: "At most one active company",
    response: json(orgListSchema),
  }),
  createOrg: defineRoute({
    id: "createOrg",
    method: "POST",
    path: "/api/orgs",
    section: "Company",
    summary: "First-run company setup with an empty ledger",
    auth: "admin",
    body: jsonBody(createOrgRequestSchema),
    response: created(orgSchema),
  }),

  // Initial company import -------------------------------------------------------------------------------
  downloadImportTemplate: defineRoute({
    id: "downloadImportTemplate",
    method: "GET",
    path: "/api/import/template",
    section: "Company import",
    summary: "Download the blank Cap Table spreadsheet template",
    auth: "admin",
    access: WRITE_ROLES,
    response: file(
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      exportResponseHeadersSchema,
    ),
  }),
  previewImport: defineRoute({
    id: "previewImport",
    method: "POST",
    path: "/api/import/preview",
    section: "Company import",
    summary: "Validate uploaded Pulley reports or a filled Cap Table spreadsheet",
    auth: "admin",
    access: WRITE_ROLES,
    body: formBody(importPreviewFormSchema, IMPORT_LIMITS.requestBytes),
    response: created(importPreviewResponseSchema),
    idempotency: "none",
  }),
  commitImport: defineRoute({
    id: "commitImport",
    method: "POST",
    path: "/api/import/runs/:runId/commit",
    section: "Company import",
    summary: "Import the files that produced a reviewed preview",
    auth: "admin",
    access: WRITE_ROLES,
    body: formBody(importCommitFormSchema, IMPORT_LIMITS.requestBytes),
    response: json(importCommitResponseSchema),
    violations: ["IMPORT_NOT_READY"],
  }),
  getImportRun: defineRoute({
    id: "getImportRun",
    method: "GET",
    path: "/api/import/runs/:runId",
    section: "Company import",
    summary: "Get an import run's status and counts",
    auth: "admin",
    access: WRITE_ROLES,
    response: json(importRunSchema),
  }),
  getOrg: defineRoute({
    id: "getOrg",
    method: "GET",
    path: "/api/orgs/:orgId",
    section: "Company",
    summary: "Profile, settings and ledger head",
    auth: "admin",
    permission: "The EIN is masked for RW and RO",
    response: json(orgSchema),
  }),
  patchOrg: defineRoute({
    id: "patchOrg",
    method: "PATCH",
    path: "/api/orgs/:orgId",
    section: "Company and administrator links",
    summary: "Profile and company settings",
    auth: "admin",
    body: jsonBody(patchOrgRequestSchema),
    response: json(orgSchema),
    version: true,
    violations: ["SHARE_UNIT_FROZEN"],
  }),
  listSignatories: defineRoute({
    id: "listSignatories",
    method: "GET",
    path: "/api/orgs/:orgId/signatories",
    section: "Signatories",
    summary: "The company's imported signatory records (view only)",
    auth: "admin",
    response: json(orgSignatoryListSchema),
  }),
  listAdminLinks: defineRoute({
    id: "listAdminLinks",
    method: "GET",
    path: "/api/orgs/:orgId/admin-links",
    section: "Signatories",
    summary: "Admin-to-stakeholder links (the self-dealing block)",
    auth: "admin",
    response: json(adminStakeholderLinkListSchema),
  }),
  createAdminLink: defineRoute({
    id: "createAdminLink",
    method: "POST",
    path: "/api/orgs/:orgId/admin-links",
    section: "Signatories",
    summary: "Link an admin's address to a stakeholder",
    auth: "admin",
    body: jsonBody(createAdminLinkRequestSchema),
    response: created(adminStakeholderLinkSchema),
  }),
  removeAdminLink: defineRoute({
    id: "removeAdminLink",
    method: "POST",
    path: "/api/orgs/:orgId/admin-links/:id/remove",
    section: "Signatories",
    summary: "Remove an admin link",
    auth: "admin",
    permission: "The linked administrator cannot remove their own link (403 self_dealing); a different administrators must remove it",
    body: jsonBody(reasonRequestSchema),
    response: json(adminStakeholderLinkSchema),
    errors: ["self_dealing"],
  }),

  // Payment instructions ------------------------------------------------------------------------------------
  getPaymentInstructions: defineRoute({
    id: "getPaymentInstructions",
    method: "GET",
    path: "/api/orgs/:orgId/payment-instructions",
    section: "Payment instructions",
    summary: "Current payment instructions",
    auth: "admin",
    response: json(paymentInstructionSchema.nullable()),
  }),
  setPaymentInstructions: defineRoute({
    id: "setPaymentInstructions",
    method: "POST",
    path: "/api/orgs/:orgId/payment-instructions",
    section: "Payment instructions",
    summary: "Set payment instructions",
    auth: "admin",
    body: jsonBody(setPaymentInstructionsRequestSchema),
    response: json(paymentInstructionSchema),
    violations: ["ORG_NOT_ACTIVE"],
  }),
  listStakeholders: defineRoute({
    id: "listStakeholders",
    method: "GET",
    path: "/api/orgs/:orgId/stakeholders",
    section: "Stakeholders",
    summary: "Every stakeholder, with totals, portal state and e-mail addresses",
    auth: "admin",
    permission: "E-mails are masked for RO admins not in readOnlyPii",
    query: asOfQuerySchema,
    response: json(stakeholderListSchema),
  }),
  createStakeholder: defineRoute({
    id: "createStakeholder",
    method: "POST",
    path: "/api/orgs/:orgId/stakeholders",
    section: "Stakeholders",
    summary: "Create a stakeholder with e-mail addresses",
    auth: "admin",
    access: WRITE_ROLES,
    body: jsonBody(createStakeholderRequestSchema),
    response: created(stakeholderSchema),
    warnings: ["DUPLICATE_EMAIL"],
  }),
  getStakeholder: defineRoute({
    id: "getStakeholder",
    method: "GET",
    path: "/api/orgs/:orgId/stakeholders/:id",
    section: "Stakeholders",
    summary: "Profile, e-mail addresses, holdings summary, termination, leave and exercises",
    auth: "admin",
    query: asOfQuerySchema,
    response: json(stakeholderDetailSchema),
  }),
  patchStakeholder: defineRoute({
    id: "patchStakeholder",
    method: "PATCH",
    path: "/api/orgs/:orgId/stakeholders/:id",
    section: "Stakeholders",
    summary: "Edit stakeholder profile fields",
    auth: "admin",
    access: WRITE_ROLES,
    permission: "Administrators can close or reopen portal access",
    body: jsonBody(patchStakeholderRequestSchema),
    response: json(stakeholderSchema),
    version: true,
    errors: ["self_dealing"],
    violations: ["REQUIRED_STAKEHOLDER_FIELD"],
  }),
  addStakeholderEmail: defineRoute({
    id: "addStakeholderEmail",
    method: "POST",
    path: "/api/orgs/:orgId/stakeholders/:id/emails",
    section: "Stakeholders",
    summary: "Add a stakeholder e-mail",
    auth: "admin",
    access: WRITE_ROLES,
    permission: "Never on a stakeholder the admin is linked to (403 self_dealing)",
    body: jsonBody(addStakeholderEmailRequestSchema),
    response: created(stakeholderEmailSchema),
    errors: ["self_dealing"],
    warnings: ["DUPLICATE_EMAIL"],
  }),
  removeStakeholderEmail: defineRoute({
    id: "removeStakeholderEmail",
    method: "POST",
    path: "/api/orgs/:orgId/stakeholders/:id/emails/:emailId/remove",
    section: "Stakeholders",
    summary: "Remove a stakeholder e-mail",
    auth: "admin",
    access: WRITE_ROLES,
    permission: "Never on a stakeholder the admin is linked to (403 self_dealing)",
    body: jsonBody(removeStakeholderEmailRequestSchema),
    response: json(stakeholderEmailSchema),
    errors: ["self_dealing"],
  }),
  getStakeholderHoldings: defineRoute({
    id: "getStakeholderHoldings",
    method: "GET",
    path: "/api/orgs/:orgId/stakeholders/:id/holdings",
    section: "Stakeholders",
    summary: "The stakeholder's securities with admin numbers",
    auth: "admin",
    query: holdingsQuerySchema,
    response: json(stakeholderHoldingsSchema),
  }),
  previewAsStakeholder: defineRoute({
    id: "previewAsStakeholder",
    method: "GET",
    path: "/api/orgs/:orgId/stakeholders/:id/preview",
    section: "Stakeholders",
    summary: "Preview as stakeholder: exactly the PortalOverview the holder would get",
    auth: "admin",
    query: asOfQuerySchema,
    response: json(portalOverviewSchema),
  }),
  previewPortalSecurity: defineRoute({
    id: "previewPortalSecurity",
    method: "GET",
    path: "/api/orgs/:orgId/stakeholders/:id/preview/securities/:securityId",
    section: "Stakeholders",
    summary: "Preview as stakeholder: exactly the holding detail the holder would get for one of their securities",
    auth: "admin",
    query: asOfQuerySchema,
    response: json(portalSecurityDetailSchema),
  }),
  previewPortalDocuments: defineRoute({
    id: "previewPortalDocuments",
    method: "GET",
    path: "/api/orgs/:orgId/stakeholders/:id/preview/documents",
    section: "Stakeholders",
    summary: "Preview as stakeholder: exactly the documents and company resources the holder would get",
    auth: "admin",
    response: json(portalDocumentListSchema),
  }),
  previewHowToExercise: defineRoute({
    id: "previewHowToExercise",
    method: "GET",
    path: "/api/orgs/:orgId/stakeholders/:id/preview/how-to-exercise",
    section: "Stakeholders",
    summary: "Preview as stakeholder: exactly the How to exercise page the holder would get",
    auth: "admin",
    response: json(howToExerciseSchema),
  }),
  getIsoSplit: defineRoute({
    id: "getIsoSplit",
    method: "GET",
    path: "/api/orgs/:orgId/stakeholders/:id/iso-split",
    section: "Ledger and holdings",
    summary: "ISO/NSO lots by year (the $100K test)",
    auth: "admin",
    response: json(isoSplitSchema),
  }),

  // Classes, plans and vesting terms -------------------------------------------------------------------
  listStockClasses: defineRoute({
    id: "listStockClasses",
    method: "GET",
    path: "/api/orgs/:orgId/stock-classes",
    section: "Stock classes",
    summary: "Classes with authorized, issued and outstanding, reserved and available to issue",
    auth: "admin",
    query: holdingsQuerySchema,
    response: json(stockClassListSchema),
  }),
  getStockClass: defineRoute({
    id: "getStockClass",
    method: "GET",
    path: "/api/orgs/:orgId/stock-classes/:id",
    section: "Stock classes",
    summary: "A class with the history of its terms and authorized shares",
    auth: "admin",
    query: holdingsQuerySchema,
    response: json(stockClassDetailSchema),
  }),
  listStockPlans: defineRoute({
    id: "listStockPlans",
    method: "GET",
    path: "/api/orgs/:orgId/stock-plans",
    section: "Stock plans",
    summary: "Plans with size, available and outstanding",
    auth: "admin",
    query: holdingsQuerySchema,
    response: json(stockPlanListSchema),
  }),
  getStockPlan: defineRoute({
    id: "getStockPlan",
    method: "GET",
    path: "/api/orgs/:orgId/stock-plans/:id",
    section: "Stock plans",
    summary: "Capacity, the return-to-pool rules and who confirmed them, exit-window defaults, amendments",
    auth: "admin",
    query: holdingsQuerySchema,
    response: json(stockPlanDetailSchema),
  }),
  listVestingTerms: defineRoute({
    id: "listVestingTerms",
    method: "GET",
    path: "/api/orgs/:orgId/vesting-terms",
    section: "Vesting terms",
    summary: "Vesting definitions (templates=true: templates only), with the grants using each",
    auth: "admin",
    query: vestingTermsQuerySchema,
    response: json(vestingTermsListSchema),
  }),
  previewVesting: defineRoute({
    id: "previewVesting",
    method: "POST",
    path: "/api/orgs/:orgId/vesting-terms/preview",
    section: "Vesting terms",
    summary: "Expand a definition for a quantity and start date (pure: no write, no Idempotency-Key)",
    auth: "admin",
    access: READ_ROLES,
    body: jsonBody(vestingPreviewRequestSchema),
    response: json(vestingPreviewResponseSchema),
    idempotency: "none",
  }),
  getVestingTerms: defineRoute({
    id: "getVestingTerms",
    method: "GET",
    path: "/api/orgs/:orgId/vesting-terms/:id",
    section: "Vesting terms",
    summary: "One vesting definition",
    auth: "admin",
    response: json(vestingTermsSchema),
  }),
  confirmVestingTerms: defineRoute({
    id: "confirmVestingTerms",
    method: "POST",
    path: "/api/orgs/:orgId/vesting-terms/:id/confirm",
    section: "Vesting terms",
    summary: "Record once that an imported template matches the plan's schedule",
    auth: "admin",
    body: jsonBody(emptyRequestSchema),
    response: json(vestingTermsSchema),
    violations: ["NOT_AN_IMPORTED_TEMPLATE"],
  }),

  // Valuations ----------------------------------------------------------------------------------------------
  listValuations: defineRoute({
    id: "listValuations",
    method: "GET",
    path: "/api/orgs/:orgId/valuations",
    section: "Valuations",
    summary: "Valuations, newest effective first, with computed status and prices",
    auth: "admin",
    response: json(valuationListSchema),
  }),
  recordValuation: defineRoute({
    id: "recordValuation",
    method: "POST",
    path: "/api/orgs/:orgId/valuations",
    section: "Valuations",
    summary: "Record a 409A valuation with its report",
    auth: "admin",
    access: WRITE_ROLES,
    body: jsonBody(recordValuationRequestSchema),
    response: created(valuationSchema),
    violations: ["COMMON_PRICE_REQUIRED", "DUPLICATE_CLASS_PRICE", "EXPIRATION_NOT_AFTER_EFFECTIVE", "VALUATION_ON_DATE_EXISTS", "DOCUMENT_ARCHIVED"],
  }),
  getFmv: defineRoute({
    id: "getFmv",
    method: "GET",
    path: "/api/orgs/:orgId/valuations/fmv",
    section: "Valuations",
    summary: "The FMV in effect on a date: the presumptively valid valuation, split-adjusted, with its status",
    auth: "admin",
    query: fmvQuerySchema,
    response: json(fmvResponseSchema),
  }),
  flagMaterialEvent: defineRoute({
    id: "flagMaterialEvent",
    method: "POST",
    path: "/api/orgs/:orgId/valuations/material-events",
    section: "Valuations",
    summary: "Flag a material event on the valuation presumptively valid on its date (review required)",
    auth: "admin",
    access: WRITE_ROLES,
    body: jsonBody(materialEventRequestSchema),
    response: json(valuationSchema),
    violations: ["NO_PRESUMPTIVELY_VALID_409A", "EVENT_DATE_IN_FUTURE", "DOCUMENT_ARCHIVED"],
  }),
  getValuation: defineRoute({
    id: "getValuation",
    method: "GET",
    path: "/api/orgs/:orgId/valuations/:id",
    section: "Valuations",
    summary: "Events, prices, documents and the grants priced with it",
    auth: "admin",
    response: json(valuationDetailSchema),
  }),
  clearValuationReview: defineRoute({
    id: "clearValuationReview",
    method: "POST",
    path: "/api/orgs/:orgId/valuations/:id/review-cleared",
    section: "Valuations",
    summary: "Clear a review with the provider's or counsel's written confirmation",
    auth: "admin",
    body: jsonBody(reviewClearedRequestSchema),
    response: json(valuationSchema),
    violations: ["NO_REVIEW_REQUIRED", "EVENT_DATE_IN_FUTURE", "DOCUMENT_ARCHIVED"],
  }),
  reverseValuationEvent: defineRoute({
    id: "reverseValuationEvent",
    method: "POST",
    path: "/api/orgs/:orgId/valuations/:id/events/:eventId/reverse",
    section: "Valuations",
    summary: "Reverse a material-event flag raised in error (once)",
    auth: "admin",
    body: jsonBody(reverseValuationEventRequestSchema),
    response: json(valuationSchema),
    confirmation: true,
    violations: ["EVENT_NOT_REVERSIBLE"],
  }),
  voidValuation: defineRoute({
    id: "voidValuation",
    method: "POST",
    path: "/api/orgs/:orgId/valuations/:id/void",
    section: "Valuations",
    summary: "Void a valuation recorded in error",
    auth: "admin",
    body: jsonBody(voidValuationRequestSchema),
    response: json(valuationSchema),
    violations: ["EVENT_DATE_IN_FUTURE", "DOCUMENT_ARCHIVED"],
  }),

  // Commands --------------------------------------------------------------------------------------------------
  terminateStakeholder: commandRoute("terminateStakeholder", COMMANDS["terminate-stakeholder"]),
  scheduleTermination: commandRoute("scheduleTermination", COMMANDS["schedule-termination"]),
  cancelScheduledTermination: commandRoute("cancelScheduledTermination", COMMANDS["cancel-scheduled-termination"]),
  exerciseOption: commandRoute("exerciseOption", COMMANDS["exercise-option"]),
  grantEquityCompensation: commandRoute("grantEquityCompensation", COMMANDS["grant-equity-compensation"]),
  cancelSecurity: commandRoute("cancelSecurity", COMMANDS["cancel-security"]),
  markExecuted: commandRoute("markExecuted", COMMANDS["mark-executed"]),
  recordLeaveOfAbsence: commandRoute("recordLeaveOfAbsence", COMMANDS["record-leave-of-absence"]),
  extendExerciseDeadline: commandRoute("extendExerciseDeadline", COMMANDS["extend-exercise-deadline"]),
  setPlanTerms: commandRoute("setPlanTerms", COMMANDS["set-plan-terms"]),
  mergeStakeholders: commandRoute("mergeStakeholders", COMMANDS["merge-stakeholders"]),
  reverseCommand: commandRoute("reverseCommand", COMMANDS["reverse-command"]),
  getReversalPreview: defineRoute({
    id: "getReversalPreview",
    method: "GET",
    path: "/api/orgs/:orgId/commands/:id/reversal-preview",
    section: "Reversals",
    summary: "The inverse transactions, dependents, effects and diffSha256 of reversing a command",
    auth: "admin",
    response: json(reversalPreviewSchema),
  }),
  getCommand: defineRoute({
    id: "getCommand",
    method: "GET",
    path: "/api/orgs/:orgId/commands/:id",
    section: "Ledger and holdings",
    summary: "A command, its transactions, dependencies, dependents and reversal",
    auth: "admin",
    response: json(commandDetailSchema),
  }),
  listExpiryRuns: defineRoute({
    id: "listExpiryRuns",
    method: "GET",
    path: "/api/orgs/:orgId/expiry-runs",
    section: "Expiry processing",
    summary: "Report-only expiry runs pending confirmation (pending or confirming), newest first",
    auth: "admin",
    response: json(expiryRunListSchema),
  }),
  getExpiryRun: defineRoute({
    id: "getExpiryRun",
    method: "GET",
    path: "/api/orgs/:orgId/expiry-runs/:runId",
    section: "Expiry processing",
    summary: "One report-only expiry run: its state and the securities it proposes to expire",
    auth: "admin",
    params: { runId: z.coerce.number().int().positive() },
    response: json(expiryRunDetailSchema),
  }),
  confirmExpiryRun: defineRoute({
    id: "confirmExpiryRun",
    method: "POST",
    path: "/api/orgs/:orgId/expiry-runs/:runId/confirm",
    section: "Expiry processing",
    summary: "Confirm a report-only expiry run: append its cancellations, optionally switch to automatic",
    auth: "admin",
    params: { runId: z.coerce.number().int().positive() },
    query: commandQuerySchema,
    body: jsonBody(confirmExpiryRunSchema, confirmExpiryRunDryRunSchema),
    response: json(confirmExpiryRunResponseSchema),
    ledgerGuard: true,
    violations: ["NOT_IN_EXPIRY_RUN", "NOT_EXPIRABLE"],
  }),

  processDue: defineRoute({
    id: "processDue",
    method: "POST",
    path: "/api/orgs/:orgId/process-due",
    section: "Ledger commands",
    summary: "Process due scheduled terminations and expirations",
    auth: "admin",
    idempotency: "none",
    response: json(z.object({
      localDate: z.string(),
      appliedTerminations: z.number().int().nonnegative(),
      expiredSecurities: z.number().int().nonnegative(),
      proposedExpirations: z.number().int().nonnegative(),
      remainingExpirations: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
    })),
  }),

  // Ledger and holdings ---------------------------------------------------------------------------------------
  getDashboard: defineRoute({
    id: "getDashboard",
    method: "GET",
    path: "/api/orgs/:orgId/dashboard",
    section: "Dashboard",
    summary: "Company metrics, needs attention, in progress and recent activity",
    auth: "admin",
    response: json(dashboardResponseSchema),
  }),
  getCapTable: defineRoute({
    id: "getCapTable",
    method: "GET",
    path: "/api/orgs/:orgId/cap-table",
    section: "Cap table",
    summary: "The cap table as of a date and as known at a seq, by tab",
    auth: "admin",
    permission: "E-mail columns follow the PII rules",
    query: capTableQuerySchema,
    response: json(capTableResponseSchema),
  }),
  getSecuritiesStatus: defineRoute({
    id: "getSecuritiesStatus",
    method: "GET",
    path: "/api/orgs/:orgId/securities-status",
    section: "Dashboard",
    summary: "Execution pending, scheduled terminations, terminated holders' shares and options, expiring",
    auth: "admin",
    response: json(securitiesStatusSchema),
  }),
  listSecurities: defineRoute({
    id: "listSecurities",
    method: "GET",
    path: "/api/orgs/:orgId/securities",
    section: "Ledger and holdings",
    summary: "Every security with its numbers (a whole list; the SPA filters)",
    auth: "admin",
    query: securityListQuerySchema,
    response: json(securityListSchema),
  }),
  getSecurity: defineRoute({
    id: "getSecurity",
    method: "GET",
    path: "/api/orgs/:orgId/securities/:id",
    section: "Ledger and holdings",
    summary: "Terms, numbers, execution status, deadlines, lineage, certificate, legends, documents, provenance",
    auth: "admin",
    query: holdingsQuerySchema,
    response: json(securityDetailSchema),
  }),
  getSecurityVesting: defineRoute({
    id: "getSecurityVesting",
    method: "GET",
    path: "/api/orgs/:orgId/securities/:id/vesting",
    section: "Ledger and holdings",
    summary: "Vesting events with cumulative totals, accelerations and the stop",
    auth: "admin",
    query: asOfQuerySchema,
    response: json(securityVestingSchema),
  }),
  getSecurityTimeline: defineRoute({
    id: "getSecurityTimeline",
    method: "GET",
    path: "/api/orgs/:orgId/securities/:id/timeline",
    section: "Ledger and holdings",
    summary: "Transactions on the lot and its lineage, oldest first, with reversals, signature acts and document events",
    auth: "admin",
    response: json(securityTimelineSchema),
  }),
  getTerminationPreview: defineRoute({
    id: "getTerminationPreview",
    method: "GET",
    path: "/api/orgs/:orgId/securities/:id/termination-preview",
    section: "Ledger and holdings",
    summary: "Vested, unvested, exercisable, contractual and ISO deadlines, repurchaseable on a termination date",
    auth: "admin",
    query: terminationPreviewQuerySchema,
    response: json(terminationPreviewSchema),
  }),
  listTransactions: defineRoute({
    id: "listTransactions",
    method: "GET",
    path: "/api/orgs/:orgId/transactions",
    section: "Ledger and holdings",
    summary: "The ledger, newest seq first",
    auth: "admin",
    query: transactionListQuerySchema,
    response: json(transactionPageSchema),
    pagination: true,
  }),
  getTransaction: defineRoute({
    id: "getTransaction",
    method: "GET",
    path: "/api/orgs/:orgId/transactions/:id",
    section: "Ledger and holdings",
    summary: "One transaction: payload, hashes, prevHash, command, reversal",
    auth: "admin",
    response: json(transactionDetailSchema),
  }),
  listExercises: defineRoute({
    id: "listExercises",
    method: "GET",
    path: "/api/orgs/:orgId/exercises",
    section: "Ledger and holdings",
    summary: "Every exercise, migrated and recorded",
    auth: "admin",
    query: exercisesQuerySchema,
    response: json(exerciseListSchema),
  }),
  listExerciseRequests: defineRoute({
    id: "listExerciseRequests",
    method: "GET",
    path: "/api/orgs/:orgId/exercise-requests",
    section: "Ledger and holdings",
    summary: "Migrated exercise requests, read-only",
    auth: "admin",
    response: json(exerciseRequestListSchema),
  }),
  getExerciseRequest: defineRoute({
    id: "getExerciseRequest",
    method: "GET",
    path: "/api/orgs/:orgId/exercise-requests/:id",
    section: "Ledger and holdings",
    summary: "One migrated exercise request",
    auth: "admin",
    response: json(exerciseRequestSchema),
  }),
  listSignatureRequests: defineRoute({
    id: "listSignatureRequests",
    method: "GET",
    path: "/api/orgs/:orgId/signature-requests",
    section: "Ledger and holdings",
    summary: "Pulley's signature state at the freeze (immutable evidence)",
    auth: "admin",
    query: securityFilterQuerySchema,
    response: json(signatureRequestListSchema),
  }),
  listCertificates: defineRoute({
    id: "listCertificates",
    method: "GET",
    path: "/api/orgs/:orgId/certificates",
    section: "Ledger and holdings",
    summary: "Migrated certificates; view only",
    auth: "admin",
    response: json(certificateListSchema),
  }),
  listLegends: defineRoute({
    id: "listLegends",
    method: "GET",
    path: "/api/orgs/:orgId/legends",
    section: "Ledger and holdings",
    summary: "Migrated legends; view only",
    auth: "admin",
    response: json(legendListSchema),
  }),
  listCertificateTerms: defineRoute({
    id: "listCertificateTerms",
    method: "GET",
    path: "/api/orgs/:orgId/certificate-terms",
    section: "Ledger and holdings",
    summary: "Migrated certificate terms; view only",
    auth: "admin",
    response: json(legendListSchema),
  }),
  listElections83b: defineRoute({
    id: "listElections83b",
    method: "GET",
    path: "/api/orgs/:orgId/elections-83b",
    section: "Ledger and holdings",
    summary: "Migrated 83(b) records; view only",
    auth: "admin",
    query: securityFilterQuerySchema,
    response: json(election83bListSchema),
  }),
  listOrgAudit: defineRoute({
    id: "listOrgAudit",
    method: "GET",
    path: "/api/orgs/:orgId/audit",
    section: "Ledger and holdings",
    summary: "The org's audit log, newest first",
    auth: "admin",
    permission: "Personal data masked for RO admins outside readOnlyPii",
    query: orgAuditQuerySchema,
    response: json(auditPageSchema),
    pagination: true,
  }),

  // Documents -------------------------------------------------------------------------------------------------
  uploadDocument: defineRoute({
    id: "uploadDocument",
    method: "POST",
    path: "/api/orgs/:orgId/documents",
    section: "Documents",
    summary: "Upload a document: a raw body up to 10 MiB with X-Filename, X-Document-Kind and X-Content-SHA256",
    auth: "admin",
    access: WRITE_ROLES,
    body: rawBody(uploadHeadersSchema, LIMITS.uploadBytes),
    response: created(documentSchema),
  }),
  listDocuments: defineRoute({
    id: "listDocuments",
    method: "GET",
    path: "/api/orgs/:orgId/documents",
    section: "Documents",
    summary: "Documents, newest first",
    auth: "admin",
    query: documentListQuerySchema,
    response: json(documentPageSchema),
    pagination: true,
  }),
  getDocument: defineRoute({
    id: "getDocument",
    method: "GET",
    path: "/api/orgs/:orgId/documents/:id",
    section: "Documents",
    summary: "Metadata, links and versions",
    auth: "admin",
    response: json(documentDetailSchema),
  }),
  patchDocument: defineRoute({
    id: "patchDocument",
    method: "PATCH",
    path: "/api/orgs/:orgId/documents/:id",
    section: "Documents",
    summary: "Edit metadata, folder and archived state",
    auth: "admin",
    access: WRITE_ROLES,
    body: jsonBody(patchDocumentRequestSchema),
    response: json(documentSchema),
    version: true,
  }),
  addDocumentLink: defineRoute({
    id: "addDocumentLink",
    method: "POST",
    path: "/api/orgs/:orgId/documents/:id/links",
    section: "Documents",
    summary: "Link a document to a target (append-only)",
    auth: "admin",
    access: WRITE_ROLES,
    body: jsonBody(addDocumentLinkRequestSchema),
    response: json(documentSchema),
    violations: ["MULTIPLE_HOLDERS", "DOCUMENT_IS_COMPANY_RESOURCE"],
  }),
  revokeDocumentLink: defineRoute({
    id: "revokeDocumentLink",
    method: "POST",
    path: "/api/orgs/:orgId/documents/:id/links/:linkId/revoke",
    section: "Documents",
    summary: "Revoke a live link once",
    auth: "admin",
    access: WRITE_ROLES,
    body: jsonBody(revokeLinkRequestSchema),
    response: json(documentSchema),
    violations: ["LINK_PERMANENT"],
  }),
  setHolderVisibility: defineRoute({
    id: "setHolderVisibility",
    method: "POST",
    path: "/api/orgs/:orgId/documents/:id/holder-visibility",
    section: "Documents",
    summary: "Show or hide a document in the portal",
    auth: "admin",
    access: WRITE_ROLES,
    permission: "Company resources (no holder link): administrators only, from the portal settings page",
    body: jsonBody(holderVisibilityRequestSchema),
    response: json(documentSchema),
    version: true,
    violations: ["MULTIPLE_HOLDERS"],
  }),
  uploadDocumentVersion: defineRoute({
    id: "uploadDocumentVersion",
    method: "POST",
    path: "/api/orgs/:orgId/documents/:id/versions",
    section: "Documents",
    summary: "Upload a new version: a new document superseding this one, which stays",
    auth: "admin",
    access: WRITE_ROLES,
    body: rawBody(uploadHeadersSchema, LIMITS.uploadBytes),
    response: created(documentSchema),
  }),
  downloadDocument: defineRoute({
    id: "downloadDocument",
    method: "GET",
    path: "/api/orgs/:orgId/documents/:id/download",
    section: "Documents",
    summary: "Stream the bytes, audited before delivery",
    auth: "admin",
    permission: "For RO admins a download counts as an export",
    response: file(DOCUMENT_CONTENT_TYPES, downloadResponseHeadersSchema),
  }),
  listCollections: defineRoute({
    id: "listCollections",
    method: "GET",
    path: "/api/orgs/:orgId/collections",
    section: "Documents",
    summary: "Folders and migrated template groups",
    auth: "admin",
    response: json(documentCollectionListSchema),
  }),
  createCollection: defineRoute({
    id: "createCollection",
    method: "POST",
    path: "/api/orgs/:orgId/collections",
    section: "Documents",
    summary: "Create a folder",
    auth: "admin",
    access: WRITE_ROLES,
    body: jsonBody(createCollectionRequestSchema),
    response: created(documentCollectionSchema),
  }),
  patchCollection: defineRoute({
    id: "patchCollection",
    method: "PATCH",
    path: "/api/orgs/:orgId/collections/:id",
    section: "Documents",
    summary: "Rename, move or archive a folder (template groups are read-only)",
    auth: "admin",
    access: WRITE_ROLES,
    body: jsonBody(patchCollectionRequestSchema),
    response: json(documentCollectionSchema),
    version: true,
    violations: ["COLLECTION_CYCLE"],
  }),

  // Reports ---------------------------------------------------------------------------------------------------
  runReport: defineRoute({
    id: "runReport",
    method: "GET",
    path: "/api/orgs/:orgId/reports/:reportKey",
    section: "Reports",
    summary: "Run one of the six current-release exports (CSV, XLSX or JSON), audited before the first byte",
    auth: "admin",
    permission: "Console administrators may include PII; holder access cannot run reports",
    params: { reportKey: reportKeySchema },
    query: reportQuerySchema,
    response: file(Object.values(REPORT_CONTENT_TYPES), exportResponseHeadersSchema, reportJsonSchema),
    errors: ["payload_too_large"],
  }),
  getPortalOverview: defineRoute({
    id: "getPortalOverview",
    method: "GET",
    path: "/api/portal/overview",
    section: "Holder portal",
    summary: "The caller's holdings across every matched org (allowlist schema)",
    auth: "holder",
    permission: HOLDER_PERMISSION,
    query: asOfQuerySchema,
    response: json(portalOverviewSchema),
  }),
  getPortalSecurity: defineRoute({
    id: "getPortalSecurity",
    method: "GET",
    path: "/api/portal/orgs/:orgId/securities/:id",
    section: "Holder portal",
    summary: "One of the caller's own securities, with its holding detail",
    auth: "holder",
    permission: HOLDER_PERMISSION,
    query: asOfQuerySchema,
    response: json(portalSecurityDetailSchema),
  }),
  listPortalDocuments: defineRoute({
    id: "listPortalDocuments",
    method: "GET",
    path: "/api/portal/orgs/:orgId/documents",
    section: "Holder portal",
    summary: "The caller's documents plus company resources",
    auth: "holder",
    permission: HOLDER_PERMISSION,
    response: json(portalDocumentListSchema),
  }),
  getHowToExercise: defineRoute({
    id: "getHowToExercise",
    method: "GET",
    path: "/api/portal/orgs/:orgId/how-to-exercise",
    section: "Holder portal",
    summary: "How to exercise: text, counsel's notice form, the active payment instructions, the company contact",
    auth: "holder",
    permission: HOLDER_PERMISSION,
    response: json(howToExerciseSchema),
  }),
  downloadPortalDocument: defineRoute({
    id: "downloadPortalDocument",
    method: "GET",
    path: "/api/portal/documents/:id/download",
    section: "Holder portal",
    summary: "Stream a document the caller may see, audited before delivery",
    auth: "holder",
    permission: HOLDER_PERMISSION,
    response: file(DOCUMENT_CONTENT_TYPES, downloadResponseHeadersSchema),
  }),

  // Audit and system -----------------------------------------------------------------------------------------
  verifyLedger: defineRoute({
    id: "verifyLedger",
    method: "POST",
    path: "/api/admin/orgs/:orgId/verify-ledger",
    section: "Audit and system",
    summary: "Verify an org's ledger now",
    auth: "admin",
    response: json(ledgerVerificationSchema),
  }),

} as const;

export type Routes = typeof routes;
export type RouteId = keyof Routes;

/** Every route served by the app. */
export const ROUTE_TABLE: readonly AnyRoute[] = Object.values(routes as Record<string, AnyRoute>);

const BY_ID = new Map(ROUTE_TABLE.map((route) => [route.id, route]));
export function routeById(id: string): AnyRoute | undefined {
  return BY_ID.get(id);
}
