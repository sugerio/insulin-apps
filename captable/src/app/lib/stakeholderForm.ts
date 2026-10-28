import type { api } from "#shared";

// The stakeholder form: what the admin types, checked the
// way the contract will check it, and turned into `CreateStakeholderRequest` or a PATCH of only what changed.

export interface StakeholderValues {
  kind: api.Stakeholder["kind"];
  legalName: string;
  displayName: string;
  /** Create only: the individual's own e-mail, or an institution's authorized contact. */
  email: string;
  contactName: string;
  contactRole: string;
  relationship: api.Relationship;
  hireDate: string;
  issuerAssignedId: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  countryOfResidence: string;
  comments: string;
}

export const EMPTY_STAKEHOLDER: StakeholderValues = {
  kind: "individual", legalName: "", displayName: "", email: "", contactName: "", contactRole: "", relationship: "employee",
  hireDate: "", issuerAssignedId: "", phone: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "", countryOfResidence: "",
  comments: "",
};

/** The form as it starts for an existing record (PII the admin may not see is never in the record). */
export function valuesOf(stakeholder: api.Stakeholder): StakeholderValues {
  return {
    ...EMPTY_STAKEHOLDER,
    kind: stakeholder.kind,
    legalName: stakeholder.legalName ?? stakeholder.displayName,
    displayName: stakeholder.displayName === (stakeholder.legalName ?? stakeholder.displayName) ? "" : stakeholder.displayName,
    relationship: stakeholder.relationship,
    hireDate: stakeholder.hireDate ?? "",
    issuerAssignedId: stakeholder.issuerAssignedId ?? "",
    phone: stakeholder.phone ?? "",
    line1: stakeholder.address?.line1 ?? "",
    line2: stakeholder.address?.line2 ?? "",
    city: stakeholder.address?.city ?? "",
    region: stakeholder.address?.region ?? "",
    postalCode: stakeholder.address?.postalCode ?? "",
    country: stakeholder.address?.country ?? "",
    countryOfResidence: stakeholder.countryOfResidence ?? "",
    comments: stakeholder.comments ?? "",
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type StakeholderErrors = Partial<Record<keyof StakeholderValues, string>>;

// The optional profile fields (hire date, external ID, phone, address, country of residence, comments) clear when
// emptied: patchRequest sends null (the address clears whole). The legal name is nullable on the server
// too, but the form keeps it: it is the name the record shows when no display name is set. Required fields are never
// sent as null (422 REQUIRED_STAKEHOLDER_FIELD).
const ADDRESS_PARTS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;

/** The client's checks (the contract's shapes); the server still judges duplicates and self-dealing. */
export function validateStakeholder(values: StakeholderValues, mode: "create" | "edit"): StakeholderErrors {
  const errors: StakeholderErrors = {};
  if (!values.legalName.trim()) errors.legalName = "Legal name is required.";
  if (values.legalName.length > 200) errors.legalName = "At most 200 characters.";
  if (mode === "create") {
    if (values.kind === "institution" && !EMAIL.test(values.email.trim())) errors.email = "Enter a valid e-mail address.";
    else if (values.email.trim() && !EMAIL.test(values.email.trim())) errors.email = "Enter a valid e-mail address.";
  }
  if (values.hireDate && !DATE.test(values.hireDate)) errors.hireDate = "Enter a date.";
  const address = [values.line1, values.line2, values.city, values.region, values.postalCode, values.country].some((part) => part.trim() !== "");
  if (address) {
    if (!values.line1.trim()) errors.line1 = "Enter the street address, or clear the address.";
    if (!values.city.trim()) errors.city = "Enter the city.";
    if (!COUNTRY.test(values.country.trim())) errors.country = "Use a two-letter country code, e.g. US.";
  }
  if (values.countryOfResidence.trim() && !COUNTRY.test(values.countryOfResidence.trim())) errors.countryOfResidence = "Use a two-letter country code, e.g. US.";
  if (values.issuerAssignedId.length > 64) errors.issuerAssignedId = "At most 64 characters.";
  if (values.phone.length > 40) errors.phone = "At most 40 characters.";
  if (values.comments.length > 4000) errors.comments = "At most 4,000 characters.";
  return errors;
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function addressOf(values: StakeholderValues): api.Stakeholder["address"] {
  if (!values.line1.trim()) return null;
  return {
    line1: values.line1.trim(),
    ...(optional(values.line2) ? { line2: values.line2.trim() } : {}),
    city: values.city.trim(),
    ...(optional(values.region) ? { region: values.region.trim() } : {}),
    ...(optional(values.postalCode) ? { postalCode: values.postalCode.trim() } : {}),
    country: values.country.trim().toUpperCase(),
  };
}

export type CreateRequest = api.CreateStakeholderRequestInput;

/** `POST …/stakeholders`: the new record with its e-mail addresses. */
export function createRequest(values: StakeholderValues): CreateRequest {
  const institution = values.kind === "institution";
  const emails: api.StakeholderEmailRequestInput[] = [];
  if (institution && optional(values.email)) emails.push({
    email: values.email.trim(), kind: "contact",
    ...(optional(values.contactName) ? { contactName: values.contactName.trim() } : {}),
    ...(optional(values.contactRole) ? { contactRole: values.contactRole.trim() } : {}),
  });
  if (!institution && optional(values.email)) emails.push({ email: values.email.trim(), kind: "self" });
  const address = addressOf(values);
  return {
    kind: values.kind,
    displayName: (optional(values.displayName) ?? values.legalName).trim(),
    legalName: values.legalName.trim(),
    relationship: values.relationship,
    ...(optional(values.issuerAssignedId) ? { issuerAssignedId: values.issuerAssignedId.trim() } : {}),
    ...(address ? { address } : {}),
    ...(optional(values.phone) ? { phone: values.phone.trim() } : {}),
    ...(optional(values.countryOfResidence) ? { countryOfResidence: values.countryOfResidence.trim().toUpperCase() } : {}),
    ...(values.hireDate ? { hireDate: values.hireDate } : {}),
    ...(optional(values.comments) ? { comments: values.comments.trim() } : {}),
    emails,
  };
}

/**
 * `PATCH …/stakeholders/:id`: only the fields that differ from the record, with its version (409 stale_version
 * otherwise). An optional field the admin emptied is sent as null, which clears it; one left alone is left out.
 */
export function patchRequest(values: StakeholderValues, original: api.Stakeholder): api.PatchStakeholderRequestInput {
  const before = valuesOf(original);
  const changed = (key: keyof StakeholderValues) => values[key].trim() !== before[key].trim();
  const patch: api.PatchStakeholderRequestInput = { version: original.version };
  if (changed("kind")) patch.kind = values.kind;
  const displayName = (optional(values.displayName) ?? values.legalName).trim();
  if (displayName !== original.displayName) patch.displayName = displayName;
  if (values.legalName.trim() !== (original.legalName ?? original.displayName)) patch.legalName = values.legalName.trim();
  if (changed("relationship") && values.relationship !== "ex_employee") patch.relationship = values.relationship;
  if (changed("hireDate")) patch.hireDate = values.hireDate || null;
  if (changed("issuerAssignedId")) patch.issuerAssignedId = optional(values.issuerAssignedId) ?? null;
  if (changed("phone")) patch.phone = optional(values.phone) ?? null;
  if (ADDRESS_PARTS.some(changed)) patch.address = addressOf(values);
  if (changed("countryOfResidence")) patch.countryOfResidence = optional(values.countryOfResidence)?.toUpperCase() ?? null;
  if (changed("comments")) patch.comments = optional(values.comments) ?? null;
  return patch;
}

/** Whether a PATCH carries anything besides the version. */
export function hasChanges(patch: api.PatchStakeholderRequestInput): boolean {
  return Object.keys(patch).some((key) => key !== "version");
}

/** Where the server's issues on a stakeholder request land on the form. */
export function stakeholderIssueField(path: string): keyof StakeholderValues | null {
  if (path.startsWith("emails")) return "email";
  if (path.startsWith("address.")) {
    const part = path.slice("address.".length);
    return (["line1", "line2", "city", "region", "postalCode", "country"] as const).find((key) => key === part) ?? "line1";
  }
  const direct = ["legalName", "displayName", "relationship", "hireDate", "issuerAssignedId", "phone", "countryOfResidence", "comments", "kind"] as const;
  return direct.find((key) => key === path) ?? null;
}

/** Another stakeholder already using an address (compared only when the list shows it unmasked). */
export function duplicateOwner(stakeholders: readonly api.Stakeholder[], email: string, exceptId?: string): api.Stakeholder | null {
  const address = email.trim().toLowerCase();
  if (!address || address.includes("•")) return null;
  return stakeholders.find((stakeholder) => stakeholder.id !== exceptId && stakeholder.emails.some((item) => item.removedAt === null && item.email.toLowerCase() === address)) ?? null;
}

/** A field the record changed on the server while the admin was editing (shown after a stale answer). */
export interface ServerChange {
  field: keyof StakeholderValues;
  before: string;
  after: string;
  /** The admin had edited it too: their value replaces the server's if they confirm. */
  conflict: boolean;
}

const COMPARED: readonly (keyof StakeholderValues)[] = [
  "kind", "legalName", "displayName", "relationship", "hireDate", "issuerAssignedId", "phone", ...ADDRESS_PARTS, "countryOfResidence", "comments",
];

function text(value: StakeholderValues[keyof StakeholderValues]): string {
  return value;
}

/**
 * After 409 stale_version: the fresh record becomes the base. The admin's edits are the fields that differ from the
 * record they started from; those are kept. Every other field takes the fresh value, so a concurrent change is never
 * overwritten. Each field the server changed is reported, as a conflict when the admin edited it too.
 */
export function rebaseStakeholder(values: StakeholderValues, base: api.Stakeholder, fresh: api.Stakeholder): { values: StakeholderValues; changes: ServerChange[] } {
  const was = valuesOf(base);
  const now = valuesOf(fresh);
  const next: Record<string, unknown> = { ...values };
  const changes: ServerChange[] = [];
  for (const field of COMPARED) {
    const edited = values[field] !== was[field];
    if (!edited) next[field] = now[field];
    if (was[field] !== now[field]) changes.push({ field, before: text(was[field]), after: text(now[field]), conflict: edited && values[field] !== now[field] });
  }
  return { values: next as unknown as StakeholderValues, changes };
}
