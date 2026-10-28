import type { api } from "#shared";
import { formatDate } from "./format.ts";

// Facts the stakeholder pages derive from a Stakeholder record.

export function activeEmails(stakeholder: api.Stakeholder): api.StakeholderEmail[] {
  return stakeholder.emails.filter((email) => email.removedAt === null);
}

/** Current employees and founders, until a termination takes effect. */
export function isActiveStaff(stakeholder: api.Stakeholder): boolean {
  return (stakeholder.relationship === "employee" || stakeholder.relationship === "founder" || stakeholder.relationship === "officer") && stakeholder.termination === null;
}

/** Whose address an e-mail is: the stakeholder's own, an institution's authorized contact, or a representative's. */
export function emailKindLabel(email: Pick<api.StakeholderEmail, "kind">): string {
  return email.kind === "representative" ? "Representative" : email.kind === "contact" ? "Authorized contact" : "Own address";
}

/** Addresses that appear on more than one stakeholder (the Duplicate badge; compared only when they're unmasked). */
export function duplicateEmails(stakeholders: readonly api.Stakeholder[]): Set<string> {
  const counts = new Map<string, number>();
  for (const stakeholder of stakeholders) {
    for (const email of new Set(activeEmails(stakeholder).map((item) => item.email.toLowerCase()))) {
      if (email.includes("•")) continue;
      counts.set(email, (counts.get(email) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([email]) => email));
}

export function statusOf(stakeholder: api.Stakeholder): "active" | "terminating" | "terminated" {
  if (stakeholder.scheduledTermination) return "terminating";
  if (stakeholder.termination) return "terminated";
  return "active";
}

export function addressLine(address: api.Stakeholder["address"]): string | null {
  if (!address) return null;
  return [address.line1, address.line2, address.city, [address.region, address.postalCode].filter(Boolean).join(" "), address.country].filter(Boolean).join(", ");
}

export function leaveLabel(leaves: api.Stakeholder["leaveOfAbsence"]): string | null {
  const leave = leaves.at(-1);
  if (!leave) return null;
  return `${formatDate(leave.startDate)} → ${leave.endDate ? formatDate(leave.endDate) : "open"} · return ${leave.returnGuaranteed ? "guaranteed" : "not guaranteed"}`;
}
