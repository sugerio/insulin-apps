import type { api, engine } from "#shared";
import type { AppConfig } from "../config.ts";
import type { DocumentLinkRole, DocumentRow } from "../documents/types.ts";
import type { LoadedLedger } from "../read/ledger.ts";
import type { OwnedOrgRow } from "../read/org.ts";
import type { AppDeps } from "../../types.ts";
import type { ApiViolation, ApiWarning } from "./errors.ts";
import type { Stmt } from "./statements.ts";

/** Who records a command: a console user or bounded on-demand maintenance. */
export interface Actor {
  kind: engine.ActorKind;
  userId: string | null;
  email: string | null;
  authMethod: "console" | null;
  /** The receipt's actor: the user id, `system:<purpose>` or an importer-specific identity. */
  receiptActor: string;
  fullAccess: boolean;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Everything a command builder reads: the org, its decoded ledger and the clock. */
export interface CommandContext {
  db: D1Database;
  config: AppConfig | null;
  deps: Pick<AppDeps, "now">;
  org: OwnedOrgRow;
  settings: api.OrgSettings;
  ledger: LoadedLedger;
  now: number;
  /** The org's local date: no ledger date may be after it (I10). */
  today: string;
  actor: Actor;
  source: engine.TransactionSource;
}

export interface TxDraft {
  type: engine.TransactionTypeCode;
  effectiveDate: string;
  payload: Record<string, unknown>;
  /** Imported transactions keep the package's ids and Pulley references (provenance, I20). */
  id?: string;
  pulleyRef?: string | null;
  payloadVersion?: number;
}

export type LinkTargetType = "security" | "stakeholder" | "stock_plan" | "stock_class" | "valuation" | "transaction";

/** A document the command links in its batch. */
export interface DocumentUse {
  documentId: string;
  role: DocumentLinkRole;
  /** A target id, or the index of one of the command's own transactions (its id is generated with the batch). */
  target: { type: LinkTargetType; id: string } | { type: "transaction_index"; index: number };
}

export type ChangeEntity = api.CommandResult["changes"][number]["entity"];

export interface Change {
  entity: ChangeEntity;
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface VestingTermsDraft {
  id: string;
  name: string;
  definition: engine.VestingDefinition;
  definitionSha256: string;
}

/** Statements the batch builder accepts: data, or statements prepared by workflow helpers. */
export type BatchStatement = Stmt | D1PreparedStatement;

/**
 * A command as its builder plans it, before the engine has judged it: the transactions and new identities to append,
 * the product rules it broke, and the workflow, document and audit work that rides in the same batch.
 */
export interface CommandPlan {
  /** `commands.type`: the command's name (`terminate-stakeholder`, `expire-securities`, …). */
  name: string;
  commandId: string;
  transactions: TxDraft[];
  securities: engine.SecurityIdentity[];
  /** Provenance of imported identities. */
  securityProvenance?: Map<string, { pulleyId: string | null }>;
  vestingTerms: VestingTermsDraft[];
  reversesCommandId: string | null;
  note: string | null;
  violations: ApiViolation[];
  warnings: ApiWarning[];
  documents: DocumentUse[];
  /** Workflow transitions, run after the dependencies (UPDATE by id with version + 1, the ledger rules). */
  workflow: BatchStatement[];
  audit: { summary: string; targetType: string; targetId: string; details?: Record<string, unknown> };
  created: { securityIds: string[]; scheduledTerminationIds: string[]; vestingTermsIds: string[] };
  /** Changes the engine doesn't see, such as a relationship restored on a stakeholder row. */
  extraChanges: Change[];
  /** Non-ledger rows whose exact reviewed values must participate in the dry-run diff hash. */
  reviewedInputs: unknown[];
  /** Every id generated for this call: the diff hash replaces them so a dry run and the real call agree. */
  generatedIds: string[];
  /** The contract's names for engine codes this command reports (the API contract). */
  codeMap?: Record<string, string>;
  /** Engine warnings this command shows as its own warnings; any other engine warning is shown as it is. */
  ignoredEngineWarnings?: readonly string[];
  /** exercise-option: the lots and portions derived for the exercise date (`CommandResult.exercise`). */
  exercise?: NonNullable<api.CommandResult["exercise"]>;
  /** merge-stakeholders: the server-computed preview shown before typed confirmation. */
  stakeholderMerge?: NonNullable<api.CommandResult["stakeholderMerge"]>;
  /** merge-stakeholders: the already-recorded edges used to prove the replay remains verifiable. */
  mergeNeutrality?: { recordedDependencies: engine.DependencyEdge[] };
}

export interface LoadedDocuments {
  rows: Map<string, DocumentRow>;
}
