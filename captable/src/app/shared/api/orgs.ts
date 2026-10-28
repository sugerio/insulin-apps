import "./zod-config.ts";
import { z } from "zod";
import { addressSchema } from "./common.ts";
import {
  adminLinkSourceSchema,
  ENTITY_TYPES,
  expiryModeSchema,
  orgStatusSchema,
} from "./enums.ts";
import {
  currencySchema,
  einSchema,
  emailSchema,
  epochMsSchema,
  isoDateSchema,
  ledgerSeqSchema,
  listSchema,
  monthDaySchema,
  noteSchema,
  orgKeySchema,
  positiveDecimalSchema,
  sha256HexSchema,
  slugSchema,
  timezoneSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";
import { importSourceSchema } from "./imports.ts";

// Orgs and access (the API contract).

// ---------------------------------------------------------------------------
// Orgs, profile and settings

/** The refusal shown when a company cannot accept a write. */
export function inactiveOrgMessage(_status: string | undefined): string {
  return "This organization can't be changed right now.";
}

/** Non-calculation settings only: nothing here changes a number; every number-moving input is a ledger fact. */
export const orgSettingsSchema = z.strictObject({
  companyContact: z.strictObject({ name: z.string().max(200), email: emailSchema }).nullable(),
  display: z.strictObject({
    shareDecimals: z.number().int().min(0).max(4),
    priceDecimals: z.number().int().min(2).max(6),
  }),
  portal: z.strictObject({
    howToExerciseText: z.string().max(8000).nullable(),
    noticeFormDocumentId: uuidSchema.nullable(), // counsel's notice of exercise, a company resource for every holder
    // Counsel's privacy notice, a company resource the portal footer opens. Required on writes like its siblings: a
    // PATCH replaces the portal section whole, so only an explicit null clears a published notice.
    privacyNoticeDocumentId: uuidSchema.nullable(),
  }),
  // Report-only until an administrator confirms the first expiry run.
  expiry: z.strictObject({ mode: expiryModeSchema }),
});
export type OrgSettings = z.output<typeof orgSettingsSchema>;

/**
 * The read side: decodes settings as stored in `orgs.settings` and as an org answer carries them. A row saved before
 * `portal.privacyNoticeDocumentId` existed lacks the key and reads as null (no notice designated); writes keep requiring
 * it (`orgSettingsSchema`), so omitting it never clears a notice.
 */
export const storedOrgSettingsSchema = orgSettingsSchema.extend({
  portal: orgSettingsSchema.shape.portal.extend({ privacyNoticeDocumentId: uuidSchema.nullable().default(null) }),
});

/**
 * The settings of a new company and of a row whose stored settings are still `{}`.
 */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  companyContact: null,
  display: { shareDecimals: 0, priceDecimals: 2 },
  portal: { howToExerciseText: null, noticeFormDocumentId: null, privacyNoticeDocumentId: null },
  expiry: { mode: "report_only" },
};

export const orgSchema = z.object({
  id: uuidSchema,
  orgKey: orgKeySchema,
  slug: slugSchema,
  status: orgStatusSchema,
  legalName: z.string(),
  displayName: z.string(),
  entityType: z.enum(ENTITY_TYPES),
  jurisdiction: z.string(),
  incorporationDate: isoDateSchema.nullable(),
  timezone: z.string(),
  currency: currencySchema,
  importSource: importSourceSchema.nullable(),
  fiscalYearEnd: monthDaySchema,
  ein: z.string().nullable(), // masked ("••-•••1234") for RW and RO
  address: addressSchema.nullable(),
  shareUnit: positiveDecimalSchema,
  shareUnitFrozen: z.boolean(),
  settings: storedOrgSettingsSchema, // decoded from the stored row (the read side)
  ledgerSeq: ledgerSeqSchema,
  ledgerHeadHash: sha256HexSchema.nullable(),
  version: versionSchema,
});
export type Org = z.infer<typeof orgSchema>;
export const orgListSchema = listSchema(orgSchema);
export type OrgList = z.infer<typeof orgListSchema>;

const orgProfileShape = {
  legalName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(100),
  jurisdiction: z.string().min(2).max(6),
  incorporationDate: isoDateSchema.nullable(),
  timezone: timezoneSchema,
  fiscalYearEnd: monthDaySchema,
  ein: einSchema.nullable(),
  address: addressSchema.nullable(),
  shareUnit: positiveDecimalSchema,
};

/**
 * `POST /api/orgs`: first-run setup for the Insulin organization's active company. The slug is the org_key. Omitted
 * fields take the schema's defaults (jurisdiction US-DE, USD, fiscal year end 12-31, share unit "1") and
 * DEFAULT_ORG_SETTINGS overlaid with `settings`.
 */
export const createOrgRequestSchema = z.strictObject({
  orgKey: orgKeySchema,
  legalName: orgProfileShape.legalName,
  displayName: orgProfileShape.displayName,
  timezone: orgProfileShape.timezone,
  jurisdiction: orgProfileShape.jurisdiction.optional(),
  incorporationDate: isoDateSchema.optional(),
  currency: currencySchema.optional(),
  fiscalYearEnd: orgProfileShape.fiscalYearEnd.optional(),
  ein: einSchema.optional(),
  address: addressSchema.optional(),
  shareUnit: orgProfileShape.shareUnit.optional(),
  settings: orgSettingsSchema.partial().optional(),
});
export type CreateOrgRequest = z.output<typeof createOrgRequestSchema>;
export type CreateOrgRequestInput = z.input<typeof createOrgRequestSchema>;

/** `PATCH /api/orgs/:orgId`. `shareUnit` changes only while the ledger is empty (422 SHARE_UNIT_FROZEN). */
export const patchOrgRequestSchema = z
  .strictObject({
    version: versionSchema,
    legalName: orgProfileShape.legalName.optional(),
    displayName: orgProfileShape.displayName.optional(),
    jurisdiction: orgProfileShape.jurisdiction.optional(),
    incorporationDate: orgProfileShape.incorporationDate.optional(),
    timezone: orgProfileShape.timezone.optional(),
    fiscalYearEnd: orgProfileShape.fiscalYearEnd.optional(),
    ein: orgProfileShape.ein.optional(),
    address: orgProfileShape.address.optional(),
    shareUnit: orgProfileShape.shareUnit.optional(),
    settings: orgSettingsSchema.partial().optional(), // each section replaces that section whole
  })
  .refine(({ version: _version, ...fields }) => Object.values(fields).some((value) => value !== undefined), "Nothing to update");
export type PatchOrgRequest = z.output<typeof patchOrgRequestSchema>;
export type PatchOrgRequestInput = z.input<typeof patchOrgRequestSchema>;

/**
 * `GET /api/orgs/:orgId/signatories`: the officers whose names and titles appear on grants, certificates, SAFEs and
 * warrants (`org_signatories`). Imported signatory records are view only. `capabilities`
 * are the signatory types as imported, lowercased (Pulley's OPTIONS_SIGNATORY → "options_signatory").
 */
export const orgSignatorySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  title: z.string().nullable(),
  capabilities: z.array(z.string()),
  active: z.boolean(),
  importedFromPulley: z.boolean(),
});
export type OrgSignatory = z.infer<typeof orgSignatorySchema>;
export const orgSignatoryListSchema = listSchema(orgSignatorySchema);
export type OrgSignatoryList = z.infer<typeof orgSignatoryListSchema>;

/** An admin-to-stakeholder link for the self-dealing block (the ledger rules; `admin_stakeholder_links`). */
export const adminStakeholderLinkSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  stakeholderId: uuidSchema,
  source: adminLinkSourceSchema,
  createdBy: z.string().nullable(),
  createdAt: epochMsSchema,
  removedAt: epochMsSchema.nullable(),
  removedBy: z.string().nullable(),
});
export type AdminStakeholderLink = z.infer<typeof adminStakeholderLinkSchema>;
export const adminStakeholderLinkListSchema = listSchema(adminStakeholderLinkSchema);

export const createAdminLinkRequestSchema = z.strictObject({
  email: emailSchema,
  stakeholderId: uuidSchema,
  source: adminLinkSourceSchema,
});
export type CreateAdminLinkRequest = z.output<typeof createAdminLinkRequestSchema>;
export type CreateAdminLinkRequestInput = z.input<typeof createAdminLinkRequestSchema>;

/** `{reason}`, used for removals of e-mails, links and admin links. */
export const reasonRequestSchema = z.strictObject({ reason: noteSchema });
export type ReasonRequest = z.output<typeof reasonRequestSchema>;

// ---------------------------------------------------------------------------
// Payment instructions

/**
 * The bank details holders see in the portal (`how-to-exercise`), never in e-mail. In admin views the account number
 * and IBAN may be masked in holder views; routing and SWIFT are bank identifiers and stay.
 */
export const paymentInstructionDetailsSchema = z.strictObject({
  bankName: z.string().max(200),
  beneficiaryName: z.string().max(200),
  beneficiaryAddress: z.string().max(500),
  accountNumber: z.string().max(34),
  routingNumber: z.string().regex(/^\d{9}$/).optional(),
  swift: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/).optional(),
  iban: z.string().max(34).optional(),
  intermediaryBank: z.string().max(500).optional(),
  checkPayee: z.string().max(200).optional(),
  checkMailingAddress: z.string().max(500).optional(),
  referenceFormat: z.string().max(100), // e.g. "EX-<grant>-<holder initials>"
});
export type PaymentInstructionDetails = z.infer<typeof paymentInstructionDetailsSchema>;

export const paymentInstructionSchema = z.strictObject({
  details: paymentInstructionDetailsSchema,
  updatedBy: z.string().nullable(),
  updatedAt: epochMsSchema,
});
export type PaymentInstruction = z.infer<typeof paymentInstructionSchema>;

export const setPaymentInstructionsRequestSchema = z.strictObject({
  details: paymentInstructionDetailsSchema,
  updatedAt: epochMsSchema.nullable(),
});
export type SetPaymentInstructionsRequest = z.output<typeof setPaymentInstructionsRequestSchema>;
