import type { LedgerCommand } from "./ledger.ts";
import type { LedgerState } from "./state.ts";

/**
 * Whole-command reversal support (the ledger rules): the causal edges the ledger writer records in `command_dependencies`
 * with each command, and the closure the reversal preview shows.
 *
 * Replay records the edges as it interprets each transaction (`LedgerState.commandReads`), so every fact a command
 * reads is covered, not a list kept beside the rules:
 *
 * | consumes_security  | it acts on a lot an earlier command issued, or on what an earlier command left of it      |
 * | relies_on_deadline | it acts on a lot whose deadline an earlier command set (a termination's window, an       |
 * |                    | extension, a repurchase date), or classifies shares by an ISO deadline                   |
 * | relies_on_terms    | it reads terms another command set: plan terms (pool return rules, default exercise and  |
 * |                    | repurchase windows, plan status), a vesting stop, an acceleration, Mark executed, a      |
 * |                    | leave that ended employment for the ISO test, a class ratio, or an earlier ISO grant     |
 * |                    | whose lots share the $100K limit                                                          |
 *
 * A command acting on a lot relies on every earlier command that acted on the same lot, so reversal on a lot runs
 * newest first. `command_dependencies` keys an edge by (command, depends-on), so one pair keeps its strongest kind.
 * What edges don't express — capacity: authorized shares (I5) and plan availability (I6) — the engine's replay-without
 * check catches (invariants.reversalViolations).
 */

export type DependencyKind = "consumes_security" | "relies_on_deadline" | "relies_on_terms";

export interface DependencyEdge {
  commandId: string;
  dependsOnCommandId: string;
  kind: DependencyKind;
}

/** One edge per pair keeps the strongest kind. */
export const DEPENDENCY_STRENGTH: Readonly<Record<DependencyKind, number>> = Object.freeze({ consumes_security: 3, relies_on_deadline: 2, relies_on_terms: 1 });

/**
 * The edges of a command, from a state replayed with it (the writer's dry run: every earlier transaction plus the new
 * command's). Only earlier commands count, so the edges never point forward. A reverse-command has none: it carries
 * nothing but X_REVERSALs, which read nothing.
 */
export function commandDependencies(state: LedgerState, commandId: string): DependencyEdge[] {
  const reads = state.commandReads.get(commandId);
  if (!reads) return [];
  return [...reads.entries()]
    .map(([dependsOnCommandId, kind]) => ({ commandId, dependsOnCommandId, kind }))
    .sort((a, b) => (a.dependsOnCommandId < b.dependsOnCommandId ? -1 : a.dependsOnCommandId > b.dependsOnCommandId ? 1 : 0));
}

/** The command that reversed `commandId`, if any. */
export function reversalOf(commandId: string, commands: readonly LedgerCommand[]): LedgerCommand | null {
  return commands.find((c) => c.reversesCommandId === commandId) ?? null;
}

function standing(commandId: string, commands: readonly LedgerCommand[]): boolean {
  return reversalOf(commandId, commands) === null;
}

function newestFirst(a: LedgerCommand, b: LedgerCommand): number {
  return b.firstSeq - a.firstSeq;
}

/** Standing commands that depend directly on the target: what blocks its reversal now (409 `dependents_exist`). */
export function reversalBlockers(targetCommandId: string, edges: readonly DependencyEdge[], commands: readonly LedgerCommand[]): LedgerCommand[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const blockers = new Set<string>();
  for (const edge of edges) {
    if (edge.dependsOnCommandId === targetCommandId && standing(edge.commandId, commands)) blockers.add(edge.commandId);
  }
  return [...blockers].map((id) => byId.get(id)).filter((c): c is LedgerCommand => c !== undefined).sort(newestFirst);
}

/**
 * The causal closure for the reversal preview: every standing command that depends on the target, directly or
 * through others, newest first. Each one is reversed first, as its own act with its own reason.
 */
export function dependentClosure(targetCommandId: string, edges: readonly DependencyEdge[], commands: readonly LedgerCommand[]): LedgerCommand[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependents.get(edge.dependsOnCommandId) ?? [];
    list.push(edge.commandId);
    dependents.set(edge.dependsOnCommandId, list);
  }
  const seen = new Set<string>();
  const queue = [targetCommandId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of dependents.get(current) ?? []) {
      if (seen.has(next) || !standing(next, commands)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].map((id) => byId.get(id)).filter((c): c is LedgerCommand => c !== undefined).sort(newestFirst);
}

export type ReversalRefusal = "not_found" | "is_reversal" | "already_reversed" | "migrated_history" | "dependents_exist";

/** The same rules the `commands_reversal_rules` trigger enforces, for the preview and the dry run. */
export function reversalRefusal(targetCommandId: string, edges: readonly DependencyEdge[], commands: readonly LedgerCommand[]): ReversalRefusal | null {
  const target = commands.find((c) => c.id === targetCommandId);
  if (!target) return "not_found";
  if (target.reversesCommandId !== null) return "is_reversal";
  if (!standing(target.id, commands)) return "already_reversed";
  if (target.actorKind === "import") return "migrated_history";
  if (reversalBlockers(target.id, edges, commands).length > 0) return "dependents_exist";
  return null;
}

/** I19: edges from a standing command to a reversed one (the trigger refuses new ones; this re-checks history). */
export function edgesOnReversedCommands(edges: readonly DependencyEdge[], commands: readonly LedgerCommand[]): DependencyEdge[] {
  return edges.filter((edge) => standing(edge.commandId, commands) && !standing(edge.dependsOnCommandId, commands));
}
