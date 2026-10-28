import type { api } from "#shared";
import { exactMoney } from "./amounts.ts";
import { DASH, formatDate } from "./format.ts";
import { EXECUTION_LABELS, RELATIONSHIP_LABELS, SECURITY_STATUS_LABELS, TERMINATION_TYPE_LABELS } from "./labels.ts";

// What a dry run (or a reversal preview) says a command changes, in words. The
// contract leaves `before` and `after` free-form; the read model fills them with the engine's snapshot keys (security
// numbers, deadlines, vesting, the stakeholder, the plan's pool, the class, the capital). Known keys get
// plain labels; any other key is shown as the server sent it. Every figure is the server's, formatted exactly:
// grouped digits, never rounded.

type Snapshot = Readonly<Record<string, unknown>> | null;
export type Change = api.CommandResult["changes"][number];

export interface ChangeRow {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface VestingRow {
  date: string;
  quantity: string;
  cumulative: string;
  kind: string;
}

export interface ChangeGroup {
  entity: Change["entity"];
  id: string;
  title: string;
  rows: ChangeRow[];
  /** A new grant's whole vesting table. */
  vesting?: VestingRow[];
}

const LABELS: Record<string, string> = {
  displayId: "ID",
  status: "Status",
  executionStatus: "Execution status",
  outstanding: "Outstanding",
  vested: "Vested",
  unvested: "Unvested",
  exercisable: "Exercisable",
  exercised: "Exercised",
  cancelled: "Cancelled",
  contractual: "Contractual deadline",
  iso: "ISO deadline",
  repurchase: "Last date to repurchase",
  stopDate: "Vesting stop",
  accelerated: "Accelerated",
  relationship: "Relationship",
  termination: "Termination",
  leaves: "Leave of absence",
  poolSize: "Plan size",
  equityOutstanding: "Equity outstanding",
  equityRetired: "Equity retired",
  availableToGrant: "Available to grant",
  issuedAndOutstanding: "Issued and outstanding",
  fullyDiluted: "Fully diluted",
  authorized: "Authorized",
  capitalContribution: "Capital contribution",
  effectiveDate: "Effective date",
};

const QUANTITIES = new Set(["outstanding", "vested", "unvested", "exercisable", "exercised", "cancelled", "accelerated", "poolSize", "equityOutstanding", "equityRetired", "availableToGrant", "issuedAndOutstanding", "fullyDiluted", "authorized", "quantity", "cumulative"]);
const MONEY = new Set(["capitalContribution"]);
const DATES = new Set(["contractual", "iso", "repurchase", "stopDate", "effectiveDate", "date", "vestingStopDate"]);
const DECIMAL = /^(0|[1-9]\d*)(\.\d{0,11}[1-9])?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : key;
}

/** One snapshot value in words, exactly as the server sent it. */
export function formatChangeValue(key: string, value: unknown, shares: (value: string) => string): string {
  if (value === null || value === undefined || value === "") return DASH;
  if (typeof value === "string") {
    if (MONEY.has(key) && DECIMAL.test(value)) return exactMoney(value);
    if (QUANTITIES.has(key) && DECIMAL.test(value)) return shares(value);
    if (DATES.has(key) && ISO_DATE.test(value)) return formatDate(value);
    if (key === "status") return SECURITY_STATUS_LABELS[value as api.SecurityStatus] ?? value;
    if (key === "executionStatus") return EXECUTION_LABELS[value as api.ExecutionStatus] ?? value;
    if (key === "relationship") return RELATIONSHIP_LABELS[value as api.Relationship] ?? value;
    if (ISO_DATE.test(value)) return formatDate(value);
    return value;
  }
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key === "termination" && typeof value === "object" && !Array.isArray(value)) {
    const termination = value as { date?: unknown; type?: unknown; vestingStopDate?: unknown };
    const type = typeof termination.type === "string" ? TERMINATION_TYPE_LABELS[termination.type as api.TerminationType] ?? termination.type : null;
    const stop = typeof termination.vestingStopDate === "string" && termination.vestingStopDate !== termination.date ? `, vesting stops ${formatDate(termination.vestingStopDate)}` : "";
    return `${typeof termination.date === "string" ? formatDate(termination.date) : DASH}${type ? ` (${type}${stop})` : ""}`;
  }
  if (key === "leaves" && Array.isArray(value)) {
    // Each leave as dates: they decide the ISO deadline.
    if (!value.length) return "None";
    return value.map((leave) => {
      const item = (leave ?? {}) as { startDate?: unknown; endDate?: unknown; returnGuaranteed?: unknown };
      const start = typeof item.startDate === "string" ? formatDate(item.startDate) : DASH;
      const end = typeof item.endDate === "string" ? formatDate(item.endDate) : "open";
      return `${start} → ${end}${item.returnGuaranteed === true ? ", return guaranteed" : ""}`;
    }).join("; ");
  }
  if (Array.isArray(value)) return value.length === 0 ? "None" : `${value.length} recorded`;
  return JSON.stringify(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function vestingRows(after: Snapshot): VestingRow[] | null {
  const events = after?.events;
  if (!Array.isArray(events)) return null;
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    const item = event as Record<string, unknown>;
    return typeof item.date === "string" && typeof item.quantity === "string" && typeof item.cumulative === "string"
      ? [{ date: item.date, quantity: item.quantity, cumulative: item.cumulative, kind: typeof item.kind === "string" ? item.kind : "" }]
      : [];
  });
}

export interface ChangeContext {
  /** Names of the plans, classes, stakeholders and securities the preview may mention, by id. */
  names: ReadonlyMap<string, string>;
  shares: (value: string) => string;
}

/** The changes, grouped per object and in words; rows whose value didn't change are left out. */
export function describeChanges(changes: readonly Change[], context: ChangeContext): ChangeGroup[] {
  // Securities are named by the display id their own snapshot carries (a new grant has no other name yet).
  const securityNames = new Map<string, string>();
  for (const change of changes) {
    if (change.entity !== "security") continue;
    const id = (change.after?.displayId ?? change.before?.displayId) as unknown;
    if (typeof id === "string") securityNames.set(change.id, id);
  }
  const nameOf = (id: string, fallback: string) => securityNames.get(id) ?? context.names.get(id) ?? fallback;
  return changes.map((change): ChangeGroup => {
    const security = nameOf(change.id, "Security");
    const title = {
      security,
      deadline: `${security} — exercise deadlines`,
      vesting: `${security} — vesting`,
      stakeholder: context.names.get(change.id) ?? "Stakeholder",
      pool: `${context.names.get(change.id) ?? "Equity plan"} — pool`,
      stock_plan: `${context.names.get(change.id) ?? "Equity plan"} — terms`,
      stock_class: context.names.get(change.id) ?? "Share class",
      capital: "Company",
    }[change.entity];
    const vesting = change.entity === "vesting" && change.before === null ? vestingRows(change.after) : null;
    if (vesting) return { entity: change.entity, id: change.id, title, rows: [], vesting };
    const keys = [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])];
    const rows = keys
      .filter((key) => !same(change.before?.[key], change.after?.[key]))
      .map((key) => ({
        key,
        label: LABELS[key] ?? humanize(key),
        before: formatChangeValue(key, change.before?.[key], context.shares),
        after: formatChangeValue(key, change.after?.[key], context.shares),
      }));
    return { entity: change.entity, id: change.id, title, rows };
  });
}

const TRANSACTION_LABELS: Record<string, string> = {
  TX_EQUITY_COMPENSATION_ISSUANCE: "Option grant",
  TX_VESTING_START: "Vesting start",
  TX_VESTING_ACCELERATION: "Vesting acceleration",
  TX_EQUITY_COMPENSATION_EXERCISE: "Exercise",
  TX_STOCK_ISSUANCE: "Share issuance (book entry)",
  TX_EQUITY_COMPENSATION_CANCELLATION: "Option cancellation",
  TX_WARRANT_CANCELLATION: "Warrant cancellation",
  X_STAKEHOLDER_TERMINATION: "Termination",
  X_SECURITY_MODIFICATION: "Exercise deadline change",
  X_EXECUTION_STATUS: "Execution status: executed",
  X_STAKEHOLDER_LEAVE: "Leave of absence",
  X_STOCK_PLAN_TERMS: "Plan terms",
  X_REVERSAL: "Reversal",
};

export function transactionLabel(type: string): string {
  return TRANSACTION_LABELS[type] ?? humanize(type.replace(/^(TX|X)_/, ""));
}

const COMMAND_LABELS: Record<string, string> = {
  "exercise-option": "Record exercise",
  "grant-equity-compensation": "Record grant",
  "terminate-stakeholder": "Termination",
  "cancel-security": "Cancellation",
  "mark-executed": "Mark executed",
  "extend-exercise-deadline": "Exercise deadline extension",
  "record-leave-of-absence": "Leave of absence",
  "set-plan-terms": "Plan terms",
  "reverse-command": "Reversal",
  "expire-securities": "Expiry (system)",
  "apply-scheduled-termination": "Scheduled termination (system)",
};

export function commandLabel(type: string): string {
  return COMMAND_LABELS[type] ?? humanize(type);
}
