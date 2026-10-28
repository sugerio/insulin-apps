import { api } from "#shared";

// How an audit event reads on screen: a sentence, the field-level changes, and who acted
// ("System", "Imported", or the person). The contract's AuditEvent carries the action, the target
// and a free-form `details` record; the sentence comes from `details.summary` when the server writes one, and from
// the action's name otherwise.

export interface AuditChange {
  field: string;
  old: string;
  new: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function humanize(action: string): string {
  const [area = "", verb = ""] = action.split(".");
  const words = (verb || area).replace(/[-_]/g, " ");
  const sentence = words.charAt(0).toUpperCase() + words.slice(1);
  return verb && area && area !== "command" ? `${sentence} (${area.replace(/_/g, " ")})` : sentence;
}

export function auditDescription(event: api.AuditEvent): string {
  return text(event.details?.summary) ?? text(event.details?.description) ?? humanize(event.action);
}

export function auditChanges(event: api.AuditEvent): AuditChange[] {
  const changes = event.details?.changes;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change: unknown) => {
    if (!change || typeof change !== "object") return [];
    const item = change as Record<string, unknown>;
    const field = text(item.field);
    if (!field) return [];
    const show = (value: unknown) => (value === null || value === undefined || value === "" ? "—" : String(value));
    return [{ field, old: show(item.old), new: show(item.new) }];
  });
}

export const ACTOR_KIND_LABELS: Record<api.AuditEvent["actor"]["kind"], string> = {
  user: "Person",
  system: "System",
  import: "Imported",
  anonymous: "Unknown",
};

function auditImportSource(event: api.AuditEvent): api.ImportSource | null {
  const declared = event.details?.source;
  if (declared === "pulley" || declared === "template") return declared;
  const description = `${text(event.details?.summary) ?? ""} ${text(event.details?.description) ?? ""}`;
  if (/\bPulley\b/i.test(description)) return "pulley";
  if (/\bspreadsheet\b/i.test(description)) return "template";
  return null;
}

/** The actor's display label; `mask` hides a personal address from those who may not see personal data. */
export function auditActor(event: api.AuditEvent, mask: (email: string) => string): string {
  if (event.actor.kind === "system") return "System";
  if (event.actor.kind === "import") return api.importSourceLabel(auditImportSource(event));
  if (event.actor.kind === "anonymous") return "Unknown";
  return event.actor.email ? mask(event.actor.email) : "Console user";
}
