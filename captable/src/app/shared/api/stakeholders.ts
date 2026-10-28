import "./zod-config.ts";
import { z } from "zod";
import { addressSchema } from "./common.ts";
import {
  portalAccessSchema,
  portalStateSchema,
  relationshipSchema,
  stakeholderEmailKindSchema,
  stakeholderKindSchema,
  taxStatusSchema,
  terminationTypeSchema,
} from "./enums.ts";
import { exerciseRecordSchema, securitySchema } from "./holdings.ts";
import { acknowledgeSchema } from "./errors.ts";
import {
  countryCodeSchema,
  decimalSchema,
  emailSchema,
  epochMsSchema,
  holdingsEchoShape,
  holdingsListSchema,
  isoDateSchema,
  noteSchema,
  ratioSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";

// Stakeholders and contact e-mails. Audit events are `stakeholder.*`; their details carry field names and
// before/after values of non-personal fields only. Merge is an audited ledger identity fact; delete remains out of scope.

/** An address on a stakeholder. Console identity is matched only against active `self` rows. */
export const stakeholderEmailSchema = z.object({
  id: uuidSchema,
  email: z.string(), // masked (a•••@example.test) for RO admins outside readOnlyPii
  kind: stakeholderEmailKindSchema,
  contactName: z.string().nullable(),
  contactRole: z.string().nullable(),
  authorizingDocumentId: uuidSchema.nullable(),
  addedBy: z.string().nullable(),
  createdAt: epochMsSchema,
  removedAt: epochMsSchema.nullable(),
});
export type StakeholderEmail = z.infer<typeof stakeholderEmailSchema>;

export const stakeholderSchema = z.object({
  id: uuidSchema,
  kind: stakeholderKindSchema,
  displayName: z.string(),
  legalName: z.string().nullable(),
  relationship: relationshipSchema,
  issuerAssignedId: z.string().nullable(),
  address: addressSchema.nullable(), // null for RO admins outside readOnlyPii
  phone: z.string().nullable(),
  countryOfResidence: z.string().nullable(),
  taxStatus: taxStatusSchema,
  hireDate: isoDateSchema.nullable(),
  comments: z.string().nullable(),
  portalAccess: portalAccessSchema,
  mergedInto: z.object({ id: uuidSchema, displayName: z.string(), commandId: uuidSchema }).nullable(),
  mergedRecords: z.array(z.object({ id: uuidSchema, displayName: z.string(), commandId: uuidSchema })),
  portalState: portalStateSchema, // computed on every read
  termination: z
    .object({ date: isoDateSchema, type: terminationTypeSchema, vestingStopDate: isoDateSchema, commandId: uuidSchema })
    .nullable(), // from the ledger
  scheduledTermination: z.object({ id: uuidSchema, terminationDate: isoDateSchema, type: terminationTypeSchema }).nullable(),
  leaveOfAbsence: z.array(z.object({ startDate: isoDateSchema, endDate: isoDateSchema.nullable(), returnGuaranteed: z.boolean() })),
  emails: z.array(stakeholderEmailSchema),
  totals: z
    .object({
      issuedAndOutstanding: decimalSchema,
      fullyDiluted: decimalSchema,
      fullyDilutedPct: ratioSchema,
      capitalContribution: decimalSchema,
    })
    .optional(),
  provenance: z.object({ importedFromPulley: z.boolean(), pulleyId: z.string().nullable() }),
  version: versionSchema,
});
export type Stakeholder = z.infer<typeof stakeholderSchema>;

/** `GET …/stakeholders?asOf=`: the whole list, with totals as of the date and portal state. */
export const stakeholderListSchema = holdingsListSchema(stakeholderSchema);
export type StakeholderList = z.infer<typeof stakeholderListSchema>;

/** `GET …/stakeholders/:id?asOf=`: the profile and holdings summary, plus the holder's exercises. */
export const stakeholderDetailSchema = stakeholderSchema.extend({ ...holdingsEchoShape, exercises: z.array(exerciseRecordSchema) });
export type StakeholderDetail = z.infer<typeof stakeholderDetailSchema>;

/** `GET …/stakeholders/:id/holdings?asOf=&asKnownAt=`: the holder's securities with admin numbers (the API contract). */
export const stakeholderHoldingsSchema = holdingsListSchema(securitySchema);
export type StakeholderHoldings = z.infer<typeof stakeholderHoldingsSchema>;

const stakeholderEmailShape = {
  email: emailSchema,
  kind: stakeholderEmailKindSchema.default("self"),
  contactName: z.string().max(200).optional(),
  contactRole: z.string().max(100).optional(),
  authorizingDocumentId: uuidSchema.optional(), // required for kind "representative"
};

// A representative (an estate's executor, a guardian) needs the document that authorizes them, as the CHECK requires.
const hasAuthorizingDocument = (email: { kind: string; authorizingDocumentId?: string | undefined }) =>
  email.kind !== "representative" || email.authorizingDocumentId !== undefined;
const AUTHORIZING_DOCUMENT_ISSUE = { path: ["authorizingDocumentId"], message: "A representative needs the authorizing document" };

/**
 * An e-mail address as entered, optionally with representative/contact metadata.
 */
export const stakeholderEmailRequestSchema = z.strictObject(stakeholderEmailShape).refine(hasAuthorizingDocument, AUTHORIZING_DOCUMENT_ISSUE);
export type StakeholderEmailRequest = z.output<typeof stakeholderEmailRequestSchema>;
export type StakeholderEmailRequestInput = z.input<typeof stakeholderEmailRequestSchema>;

export const addStakeholderEmailRequestSchema = z
  .strictObject({ ...stakeholderEmailShape, acknowledge: acknowledgeSchema })
  .refine(hasAuthorizingDocument, AUTHORIZING_DOCUMENT_ISSUE);
export type AddStakeholderEmailRequest = z.output<typeof addStakeholderEmailRequestSchema>;

/**
 * `POST …/stakeholders/:id/emails`: add one plain stakeholder e-mail.
 */
export const removeStakeholderEmailRequestSchema = z.strictObject({ reason: noteSchema.optional() });

const stakeholderProfileShape = {
  kind: stakeholderKindSchema,
  displayName: z.string().trim().min(1).max(200),
  legalName: z.string().max(200),
  issuerAssignedId: z.string().max(64),
  address: addressSchema,
  phone: z.string().max(40),
  countryOfResidence: countryCodeSchema,
  taxStatus: taxStatusSchema,
  hireDate: isoDateSchema,
  comments: z.string().max(4000),
};

/** `POST …/stakeholders`: with its initial e-mail addresses. */
export const createStakeholderRequestSchema = z.strictObject({
  kind: stakeholderProfileShape.kind,
  displayName: stakeholderProfileShape.displayName,
  legalName: stakeholderProfileShape.legalName.optional(),
  relationship: relationshipSchema,
  issuerAssignedId: stakeholderProfileShape.issuerAssignedId.optional(),
  address: stakeholderProfileShape.address.optional(),
  phone: stakeholderProfileShape.phone.optional(),
  countryOfResidence: stakeholderProfileShape.countryOfResidence.optional(),
  taxStatus: stakeholderProfileShape.taxStatus.default("unknown"),
  hireDate: stakeholderProfileShape.hireDate.optional(),
  comments: stakeholderProfileShape.comments.optional(),
  emails: z.array(stakeholderEmailRequestSchema).max(20),
  acknowledge: acknowledgeSchema,
}).superRefine((value, context) => {
  if (value.kind === "institution" && value.emails.length === 0) {
    context.addIssue({ code: "custom", path: ["emails"], message: "An institution requires an e-mail address" });
  }
});
export type CreateStakeholderRequest = z.output<typeof createStakeholderRequestSchema>;
export type CreateStakeholderRequestInput = z.input<typeof createStakeholderRequestSchema>;

/**
 * `PATCH …/stakeholders/:id`: profile fields only, and only those sent. Built without the create defaults,
 * which would otherwise reset taxStatus on every edit. Termination, the relationship it sets, and leave are
 * command-driven.
 */
export const patchStakeholderRequestSchema = z
  .strictObject({
    version: versionSchema,
    kind: stakeholderProfileShape.kind.optional(),
    displayName: stakeholderProfileShape.displayName.optional(),
    legalName: stakeholderProfileShape.legalName.nullable().optional(),
    issuerAssignedId: stakeholderProfileShape.issuerAssignedId.nullable().optional(),
    address: stakeholderProfileShape.address.nullable().optional(),
    phone: stakeholderProfileShape.phone.nullable().optional(),
    countryOfResidence: stakeholderProfileShape.countryOfResidence.nullable().optional(),
    taxStatus: stakeholderProfileShape.taxStatus.optional(),
    hireDate: stakeholderProfileShape.hireDate.nullable().optional(),
    comments: stakeholderProfileShape.comments.nullable().optional(),
    relationship: relationshipSchema.exclude(["ex_employee"]).optional(), // ex_employee is set by a termination
    portalAccess: portalAccessSchema.optional(),
  })
  .refine(({ version: _version, ...fields }) => Object.values(fields).some((value) => value !== undefined), "Nothing to update");
export type PatchStakeholderRequest = z.output<typeof patchStakeholderRequestSchema>;
export type PatchStakeholderRequestInput = z.input<typeof patchStakeholderRequestSchema>;
