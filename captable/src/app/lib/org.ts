import { api, engine } from "#shared";

// The company profile form: what an owner or admin types, checked the
// way the contract checks it, and turned into a PATCH of only what changed, with the version read. The share unit can
// change only while the ledger is empty (422 SHARE_UNIT_FROZEN once a transaction exists). Settings sections (the
// holder contact, display, the portal) replace their section whole: see `portalSection`.

export interface OrgWriteRestriction {
  title: string;
  text: string;
}

/** Why the company refuses every write, from its status; null for an active company (the only status today). */
export function orgWriteRestriction(status: string): OrgWriteRestriction | null {
  if (status === "active") return null;
  return { title: "Changes unavailable", text: "This company can't be changed right now." };
}

export interface OrgProfileValues {
  displayName: string;
  legalName: string;
  jurisdiction: string;
  incorporationDate: string;
  timezone: string;
  fiscalYearEnd: string;
  ein: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  shareUnit: string;
}

export type OrgProfileErrors = Partial<Record<keyof OrgProfileValues, string>>;

export const JURISDICTIONS: readonly (readonly [code: string, label: string])[] = [
  ["US-DE", "Delaware"],
  ["US-CA", "California"],
  ["US-NY", "New York"],
  ["US-NV", "Nevada"],
  ["US-WY", "Wyoming"],
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ENDS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The fiscal year ends a company can choose: the last day of each month (`MM-DD`). */
export const FISCAL_YEAR_ENDS: readonly (readonly [value: string, label: string])[] = MONTHS.map((month, index) => [
  `${String(index + 1).padStart(2, "0")}-${MONTH_ENDS[index]}`,
  `${month} ${MONTH_ENDS[index]}`,
]);

const COMMON_TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "UTC", "Europe/London", "Europe/Berlin", "Asia/Singapore", "Asia/Tokyo"];

/** The time zones offered: the browser's IANA list when it has one, with the org's own always included. */
export function timezones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : COMMON_TIMEZONES;
  return [...new Set([current, ...COMMON_TIMEZONES, ...all])];
}

export function orgValuesOf(org: api.Org): OrgProfileValues {
  return {
    displayName: org.displayName,
    legalName: org.legalName,
    jurisdiction: org.jurisdiction,
    incorporationDate: org.incorporationDate ?? "",
    timezone: org.timezone,
    fiscalYearEnd: org.fiscalYearEnd,
    ein: org.ein ?? "",
    line1: org.address?.line1 ?? "",
    line2: org.address?.line2 ?? "",
    city: org.address?.city ?? "",
    region: org.address?.region ?? "",
    postalCode: org.address?.postalCode ?? "",
    country: org.address?.country ?? "",
    shareUnit: org.shareUnit,
  };
}

const ADDRESS_PARTS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;

export function validateOrgProfile(values: OrgProfileValues, org: api.Org): OrgProfileErrors {
  const errors: OrgProfileErrors = {};
  if (!values.displayName.trim()) errors.displayName = "Enter the company name.";
  else if (values.displayName.trim().length > 100) errors.displayName = "At most 100 characters.";
  if (!values.legalName.trim()) errors.legalName = "Enter the legal name.";
  else if (values.legalName.trim().length > 200) errors.legalName = "At most 200 characters.";
  if (values.incorporationDate && !/^\d{4}-\d{2}-\d{2}$/.test(values.incorporationDate)) errors.incorporationDate = "Enter a date.";
  if (!/^\d{2}-\d{2}$/.test(values.fiscalYearEnd)) errors.fiscalYearEnd = "Choose the fiscal year end.";
  // A masked EIN ("••-•••1234", shown to whoever may not see it whole) is never sent back.
  if (values.ein.trim() && !values.ein.includes("•") && !/^\d{2}-\d{7}$/.test(values.ein.trim())) errors.ein = "Use the EIN's 12-3456789 format.";
  const address = ADDRESS_PARTS.some((key) => values[key].trim() !== "");
  if (address) {
    if (!values.line1.trim()) errors.line1 = "Enter the street address, or clear the whole address.";
    if (!values.city.trim()) errors.city = "Enter the city.";
    if (!/^[A-Za-z]{2}$/.test(values.country.trim())) errors.country = "Use a two-letter country code, e.g. US.";
  }
  if (values.shareUnit !== org.shareUnit) {
    if (org.shareUnitFrozen) errors.shareUnit = "The share unit is frozen: the ledger already has transactions.";
    else {
      try {
        if (!engine.Dec.from(values.shareUnit.trim()).isPositive()) errors.shareUnit = "Enter a share unit greater than 0, e.g. 1 or 0.0001.";
      } catch {
        errors.shareUnit = "Enter a share unit greater than 0, e.g. 1 or 0.0001.";
      }
    }
  }
  return errors;
}

function addressOf(values: OrgProfileValues): api.Org["address"] {
  if (!values.line1.trim()) return null;
  return {
    line1: values.line1.trim(),
    ...(values.line2.trim() ? { line2: values.line2.trim() } : {}),
    city: values.city.trim(),
    ...(values.region.trim() ? { region: values.region.trim() } : {}),
    ...(values.postalCode.trim() ? { postalCode: values.postalCode.trim() } : {}),
    country: values.country.trim().toUpperCase(),
  };
}

/** `PATCH /api/orgs/:orgId`: only the profile fields that differ from the org, with its version. */
export function orgProfilePatch(values: OrgProfileValues, org: api.Org): api.PatchOrgRequestInput {
  const before = orgValuesOf(org);
  const changed = (key: keyof OrgProfileValues) => values[key].trim() !== before[key].trim();
  const patch: api.PatchOrgRequestInput = { version: org.version };
  if (changed("displayName")) patch.displayName = values.displayName.trim();
  if (changed("legalName")) patch.legalName = values.legalName.trim();
  if (changed("jurisdiction")) patch.jurisdiction = values.jurisdiction;
  if (changed("incorporationDate")) patch.incorporationDate = values.incorporationDate || null;
  if (changed("timezone")) patch.timezone = values.timezone;
  if (changed("fiscalYearEnd")) patch.fiscalYearEnd = values.fiscalYearEnd;
  if (changed("ein") && !values.ein.includes("•")) patch.ein = values.ein.trim() || null;
  if (ADDRESS_PARTS.some(changed)) patch.address = addressOf(values);
  if (changed("shareUnit")) patch.shareUnit = engine.Dec.from(values.shareUnit.trim()).toString();
  return patch;
}

export function hasOrgChanges(patch: api.PatchOrgRequestInput): boolean {
  return Object.keys(patch).some((key) => key !== "version");
}

export const ORG_FIELD_LABELS: Record<keyof OrgProfileValues, string> = {
  displayName: "Company name", legalName: "Legal name", jurisdiction: "State of incorporation", incorporationDate: "Incorporation date",
  timezone: "Timezone", fiscalYearEnd: "Fiscal year end", ein: "EIN", line1: "Address", line2: "Address line 2", city: "City",
  region: "State or region", postalCode: "Postal code", country: "Country", shareUnit: "Share unit",
};

/** A field someone else changed while the form was open (after 409 stale_version). */
export interface OrgServerChange {
  field: keyof OrgProfileValues;
  before: string;
  after: string;
  /** The admin had edited it too: their value replaces the server's if they confirm. */
  conflict: boolean;
}

/**
 * After 409 stale_version: the fresh org becomes the base. The admin's edits (fields that differ from the org they
 * started from) are kept; every other field takes the fresh value, so a concurrent change is never overwritten.
 */
export function rebaseOrg(values: OrgProfileValues, base: api.Org, fresh: api.Org): { values: OrgProfileValues; changes: OrgServerChange[] } {
  const was = orgValuesOf(base);
  const now = orgValuesOf(fresh);
  const next = { ...values };
  const changes: OrgServerChange[] = [];
  for (const field of Object.keys(was) as (keyof OrgProfileValues)[]) {
    const edited = values[field] !== was[field];
    if (!edited) next[field] = now[field];
    if (was[field] !== now[field]) changes.push({ field, before: was[field], after: now[field], conflict: edited && values[field] !== now[field] });
  }
  return { values: next, changes };
}

/** Where the server's issues on an org PATCH land on the profile form. */
export function orgIssueField(path: string): keyof OrgProfileValues | null {
  if (path.startsWith("address.")) {
    const part = path.slice("address.".length);
    return (ADDRESS_PARTS as readonly string[]).includes(part) ? (part as keyof OrgProfileValues) : "line1";
  }
  const direct = ["displayName", "legalName", "jurisdiction", "incorporationDate", "timezone", "fiscalYearEnd", "ein", "shareUnit"] as const;
  return direct.find((key) => key === path) ?? null;
}

/**
 * The portal section of a settings PATCH. The section replaces whole and only an explicit null clears a key, so all
 * three keys are always sent: the stored ones, with the changes laid over them.
 */
export function portalSection(org: api.Org, change: Partial<api.OrgSettings["portal"]>): api.OrgSettings["portal"] {
  const stored = org.settings.portal;
  return {
    howToExerciseText: change.howToExerciseText !== undefined ? change.howToExerciseText : stored.howToExerciseText,
    noticeFormDocumentId: change.noticeFormDocumentId !== undefined ? change.noticeFormDocumentId : stored.noticeFormDocumentId,
    privacyNoticeDocumentId: change.privacyNoticeDocumentId !== undefined ? change.privacyNoticeDocumentId : stored.privacyNoticeDocumentId,
  };
}
