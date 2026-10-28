import { api, engine } from "#shared";
import { notFound } from "../../http.ts";
import { stmt } from "../statements.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertConfirmation, assertNotSelfDealing, currentState, newPlan, violation } from "./common.ts";

interface MergeRow {
  id: string;
  kind: "individual" | "institution";
  display_name: string;
  legal_name: string | null;
  relationship: engine.Relationship;
  issuer_assigned_id: string | null;
  address: string | null;
  phone: string | null;
  country_of_residence: string | null;
  tax_status: "us" | "non_us" | "unknown";
  hire_date: string | null;
  archived_at: number | null;
  merged_into_id: string | null;
  version: number;
}

interface BlockingItem { type: string; id: string; label: string; code: string }

function totals(state: engine.LedgerState, stakeholderId: string) {
  const holder = engine.computeMetrics(state).holders.find((row) => row.stakeholderId === stakeholderId);
  return {
    securityCount: (state.securitiesByStakeholder.get(stakeholderId) ?? []).filter((security) => security.issued).length,
    issuedAndOutstanding: holder?.stockOutstanding.toString() ?? "0",
    fullyDiluted: holder?.fullyDiluted.toString() ?? "0",
    capitalContribution: holder?.capitalContribution.toString() ?? "0",
  };
}

function value(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
}

export async function planStakeholderMerge(
  ctx: CommandContext,
  body: api.MergeStakeholders,
  options: { dryRun: boolean },
): Promise<CommandPlan> {
  const plan = newPlan(ctx, "merge-stakeholders");
  plan.note = body.reason;
  const { results } = await ctx.db.prepare(
    "SELECT * FROM stakeholders WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))",
  ).bind(ctx.org.id, JSON.stringify([body.mergedStakeholderId, body.survivingStakeholderId])).all<MergeRow>();
  const merged = results.find((row) => row.id === body.mergedStakeholderId);
  const survivor = results.find((row) => row.id === body.survivingStakeholderId);
  if (!merged || !survivor) throw notFound("Stakeholder not found");
  await assertNotSelfDealing(ctx, [merged.id, survivor.id]);

  const state = currentState(ctx);
  const blockers: BlockingItem[] = [];
  if (merged.id === survivor.id) blockers.push({ type: "same_record", id: merged.id, label: "Choose two different stakeholder records", code: "STAKEHOLDER_MERGE_SAME_RECORD" });
  for (const row of [merged, survivor]) {
    if (row.merged_into_id !== null) blockers.push({ type: "already_merged", id: row.id, label: `${row.display_name} is already merged`, code: "STAKEHOLDER_ALREADY_MERGED" });
    else if (row.archived_at !== null) blockers.push({ type: "archived", id: row.id, label: `${row.display_name} is archived`, code: "STAKEHOLDER_ARCHIVED" });
  }
  if (merged.kind !== survivor.kind) blockers.push({ type: "kind_mismatch", id: merged.id, label: "Individuals and institutions cannot be merged", code: "STAKEHOLDER_KIND_MISMATCH" });
  const mergedTermination = state.stakeholders.get(merged.id)?.terminations.at(-1);
  const survivorTermination = state.stakeholders.get(survivor.id)?.terminations.at(-1);
  if (mergedTermination && survivorTermination && (
    mergedTermination.date !== survivorTermination.date
    || mergedTermination.type !== survivorTermination.type
    || mergedTermination.vestingStopDate !== survivorTermination.vestingStopDate
  )) {
    blockers.push({
      type: "termination_conflict", id: merged.id,
      label: "The two termination facts must have the same date, type and vesting stop",
      code: "STAKEHOLDER_TERMINATION_CONFLICT",
    });
  }

  // Pulley's signature rows are migrated evidence that never changes, so they can't be "resolved" and
  // don't block: they stay with their securities, which follow the merged identity.
  const [
    exerciseRows, scheduledRows, duplicateDocumentRows, emailRows, adminRows, documentRows,
    reviewedDocumentRows, incomingMergeRows, dependencyRows,
  ] = await ctx.db.batch([
    ctx.db.prepare(
      `SELECT id, status FROM exercise_requests WHERE org_id = ? AND stakeholder_id = ?
       AND status IN ('NEEDS_REVIEW', 'AWAITING_HOLDER_CONFIRMATION', 'AWAITING_PAYMENT') ORDER BY id`,
    ).bind(ctx.org.id, merged.id),
    ctx.db.prepare("SELECT id, termination_date FROM scheduled_terminations WHERE org_id = ? AND stakeholder_id = ? AND status = 'SCHEDULED' ORDER BY id")
      .bind(ctx.org.id, merged.id),
    ctx.db.prepare(
      `SELECT b.id, b.document_id FROM document_links b JOIN document_links a
         ON a.document_id = b.document_id AND a.role = b.role AND a.stakeholder_id = ? AND a.revoked_at IS NULL
       WHERE b.org_id = ? AND b.stakeholder_id = ? AND b.revoked_at IS NULL ORDER BY b.id`,
    ).bind(survivor.id, ctx.org.id, merged.id),
    ctx.db.prepare(
      `SELECT b.id, b.email, CASE WHEN a.id IS NULL THEN 'move' ELSE 'deduplicate' END AS action
       FROM stakeholder_emails b LEFT JOIN stakeholder_emails a
         ON a.org_id = b.org_id AND a.stakeholder_id = ? AND a.email = b.email AND a.removed_at IS NULL
       WHERE b.org_id = ? AND b.stakeholder_id = ? AND b.removed_at IS NULL ORDER BY b.created_at, b.id`,
    ).bind(survivor.id, ctx.org.id, merged.id),
    ctx.db.prepare(
      `SELECT b.id, b.email, CASE WHEN a.id IS NULL THEN 'moved' ELSE 'deduplicated' END AS action
       FROM admin_stakeholder_links b LEFT JOIN admin_stakeholder_links a
         ON a.org_id = b.org_id AND a.stakeholder_id = ? AND a.email = b.email AND a.removed_at IS NULL
       WHERE b.org_id = ? AND b.stakeholder_id = ? AND b.removed_at IS NULL ORDER BY b.id`,
    ).bind(survivor.id, ctx.org.id, merged.id),
    ctx.db.prepare(
      `SELECT l.id FROM document_links l
       WHERE l.org_id = ? AND l.stakeholder_id = ? AND l.revoked_at IS NULL ORDER BY l.id`,
    )
      .bind(ctx.org.id, merged.id),
    ctx.db.prepare(
      `SELECT l.id, l.document_id, l.role FROM document_links l
       WHERE l.org_id = ? AND l.stakeholder_id = ? AND l.revoked_at IS NULL ORDER BY l.id`,
    ).bind(ctx.org.id, merged.id),
    ctx.db.prepare(
      "SELECT id, display_name, merged_into_id FROM stakeholders WHERE org_id = ? AND merged_into_id IN (SELECT value FROM json_each(?)) ORDER BY id",
    ).bind(ctx.org.id, JSON.stringify([merged.id, survivor.id])),
    ctx.db.prepare("SELECT command_id, depends_on_command_id, kind FROM command_dependencies WHERE org_id = ? ORDER BY command_id, depends_on_command_id")
      .bind(ctx.org.id),
  ]);
  for (const row of (exerciseRows!.results ?? []) as { id: string; status: string }[]) blockers.push({ type: "exercise_request", id: row.id, label: `Open exercise request (${row.status})`, code: "STAKEHOLDER_MERGE_BLOCKED" });
  for (const row of (scheduledRows!.results ?? []) as { id: string; termination_date: string }[]) blockers.push({ type: "scheduled_termination", id: row.id, label: `Scheduled termination on ${row.termination_date}`, code: "STAKEHOLDER_MERGE_BLOCKED" });
  for (const row of (duplicateDocumentRows!.results ?? []) as { id: string; document_id: string }[]) blockers.push({ type: "duplicate_document_link", id: row.id, label: `Document ${row.document_id} is already linked to the survivor`, code: "STAKEHOLDER_MERGE_BLOCKED" });
  for (const row of (incomingMergeRows!.results ?? []) as { id: string; display_name: string; merged_into_id: string }[]) {
    blockers.push({
      type: "merge_chain", id: row.id,
      label: `${row.display_name} is already merged into one of these records; undo that merge first`,
      code: "STAKEHOLDER_MERGE_BLOCKED",
    });
  }
  const mergedBefore = totals(state, merged.id);
  const survivorBefore = totals(state, survivor.id);
  const profileFields = [
    ["displayName", survivor.display_name, merged.display_name],
    ["legalName", survivor.legal_name, merged.legal_name],
    ["relationship", survivor.relationship, merged.relationship],
    ["issuerAssignedId", survivor.issuer_assigned_id, merged.issuer_assigned_id],
    ["address", value(survivor.address), value(merged.address)],
    ["phone", survivor.phone, merged.phone],
    ["countryOfResidence", survivor.country_of_residence, merged.country_of_residence],
    ["taxStatus", survivor.tax_status, merged.tax_status],
    ["hireDate", survivor.hire_date, merged.hire_date],
  ] as const;
  const addresses = ((emailRows!.results ?? []) as {
    id: string; email: string; action: "move" | "deduplicate";
  }[]);
  plan.stakeholderMerge = {
    merged: { id: merged.id, displayName: merged.display_name },
    survivor: { id: survivor.id, displayName: survivor.display_name },
    holdings: {
      survivorBefore,
      mergedBefore,
      // `evaluatePlan` replaces this with the totals from the actual replay containing the merge fact.
      survivorAfter: survivorBefore,
    },
    addresses: addresses.map(({ email, action }) => ({ email, action })),
    profileDifferences: profileFields.filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b)).map(([field, survivorValue, mergedValue]) => ({ field, survivorValue, mergedValue })),
    blockingItems: blockers.map(({ type, id, label }) => ({ type, id, label })),
    confirmation: merged.display_name,
  };

  for (const blocker of blockers) plan.violations.push(violation(blocker.code, blocker.label));
  if (blockers.some((blocker) => ["same_record", "already_merged", "kind_mismatch", "merge_chain"].includes(blocker.type))) {
    return plan;
  }
  if (!options.dryRun && blockers.length === 0) assertConfirmation(body.confirmation, [merged.display_name]);
  plan.transactions.push({
    type: "X_STAKEHOLDER_MERGE",
    effectiveDate: ctx.today,
    payload: { merged_stakeholder_id: merged.id, surviving_stakeholder_id: survivor.id, reason: body.reason },
  });
  plan.mergeNeutrality = {
    recordedDependencies: ((dependencyRows!.results ?? []) as {
      command_id: string; depends_on_command_id: string; kind: engine.DependencyKind;
    }[]).map((row) => ({ commandId: row.command_id, dependsOnCommandId: row.depends_on_command_id, kind: row.kind })),
  };
  plan.reviewedInputs.push({
    stakeholderEmails: addresses.map(({ id, email, action }) => ({ id, email, action })),
    adminLinks: ((adminRows!.results ?? []) as { id: string; email: string; action: string }[]),
    documentLinks: ((reviewedDocumentRows!.results ?? []) as { id: string; document_id: string; role: string }[])
      .map((row) => ({ id: row.id, documentId: row.document_id, role: row.role })),
  });
  plan.workflow.push(stmt(
    `UPDATE stakeholders SET archived_at = ?, merged_into_id = ?, merged_at = ?, merged_by_command_id = ?, version = version + 1, updated_at = ?
     WHERE org_id = ? AND id = ? AND archived_at IS NULL AND merged_into_id IS NULL`,
    ctx.now, survivor.id, ctx.now, plan.commandId, ctx.now, ctx.org.id, merged.id,
  ));
  plan.workflow.push(stmt(
    "INSERT INTO batch_assertions (ok) SELECT EXISTS (SELECT 1 FROM stakeholders WHERE org_id = ? AND id = ? AND merged_into_id = ? AND merged_by_command_id = ?)",
    ctx.org.id, merged.id, survivor.id, plan.commandId,
  ));
  plan.workflow.push(stmt(
    `UPDATE stakeholder_emails SET removed_at = ?, removed_by = ? WHERE org_id = ? AND stakeholder_id = ? AND removed_at IS NULL
       AND email IN (SELECT email FROM stakeholder_emails WHERE org_id = ? AND stakeholder_id = ? AND removed_at IS NULL)`,
    ctx.now, ctx.actor.userId, ctx.org.id, merged.id, ctx.org.id, survivor.id,
  ));
  plan.workflow.push(stmt(
    "UPDATE stakeholder_emails SET stakeholder_id = ? WHERE org_id = ? AND stakeholder_id = ? AND removed_at IS NULL",
    survivor.id, ctx.org.id, merged.id,
  ));
  for (const row of (adminRows!.results ?? []) as { id: string; action: "moved" | "deduplicated" }[]) {
    plan.workflow.push(stmt(
      "INSERT INTO stakeholder_merge_link_moves (command_id, org_id, kind, row_id, action) VALUES (?, ?, 'admin_link', ?, ?)",
      plan.commandId, ctx.org.id, row.id, row.action,
    ));
  }
  plan.workflow.push(stmt(
    `UPDATE admin_stakeholder_links SET removed_at = ?, removed_by = ? WHERE org_id = ? AND stakeholder_id = ? AND removed_at IS NULL
       AND email IN (SELECT email FROM admin_stakeholder_links WHERE org_id = ? AND stakeholder_id = ? AND removed_at IS NULL)`,
    ctx.now, ctx.actor.userId, ctx.org.id, merged.id, ctx.org.id, survivor.id,
  ));
  plan.workflow.push(stmt(
    "UPDATE admin_stakeholder_links SET stakeholder_id = ? WHERE org_id = ? AND stakeholder_id = ? AND removed_at IS NULL",
    survivor.id, ctx.org.id, merged.id,
  ));
  for (const row of (documentRows!.results ?? []) as { id: string }[]) {
    plan.workflow.push(stmt(
      "INSERT INTO stakeholder_merge_link_moves (command_id, org_id, kind, row_id, action) VALUES (?, ?, 'document_link', ?, 'moved')",
      plan.commandId, ctx.org.id, row.id,
    ));
  }
  plan.workflow.push(stmt(
    "UPDATE document_links SET stakeholder_id = ? WHERE org_id = ? AND stakeholder_id = ? AND revoked_at IS NULL",
    survivor.id, ctx.org.id, merged.id,
  ));
  plan.extraChanges.push({
    entity: "stakeholder",
    id: merged.id,
    before: { archived: false, mergedIntoId: null },
    after: { archived: true, mergedIntoId: survivor.id },
  });
  plan.audit = {
    summary: `${merged.display_name} merged into ${survivor.display_name}`,
    targetType: "stakeholder",
    targetId: merged.id,
    details: { mergedStakeholderId: merged.id, survivingStakeholderId: survivor.id, emailCount: addresses.length },
  };
  return plan;
}
