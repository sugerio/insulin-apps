import type { ImportProblem, PlannedLedgerCommand } from "./types.ts";

export interface OrderableCommand extends PlannedLedgerCommand { rank: number }
const collator = new Intl.Collator("en", { numeric: true });

export function orderCommands(commands: readonly OrderableCommand[]): { commands: PlannedLedgerCommand[]; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  const byId = new Map<string, OrderableCommand>();
  for (const command of commands) {
    if (byId.has(command.id)) problems.push({ severity: "error", code: "COMMAND_DUPLICATE", message: `The import produced two commands for ${command.sourceId}.`, source: null });
    else byId.set(command.id, command);
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const command of byId.values()) {
    const dependencies = [...new Set(command.dependencies.filter((dependency) => dependency !== command.id))];
    for (const dependency of dependencies) if (!byId.has(dependency)) problems.push({ severity: "error", code: "COMMAND_DEPENDENCY_MISSING", message: `The import could not order ${command.sourceId} because a required earlier record was not created.`, source: null });
    command.dependencies = dependencies;
    indegree.set(command.id, dependencies.length);
    for (const dependency of dependencies) {
      const existing = dependents.get(dependency);
      if (existing) existing.push(command.id);
      else dependents.set(dependency, [command.id]);
    }
  }
  const ready = new MinHeap(compare);
  for (const command of byId.values()) if (indegree.get(command.id) === 0) ready.push(command);
  const ordered: OrderableCommand[] = [];
  const emitted = new Set<string>();
  while (ready.size > 0) {
    const next = ready.pop()!; ordered.push(next); emitted.add(next.id);
    for (const dependent of dependents.get(next.id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1; indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(byId.get(dependent)!);
    }
  }
  if (ordered.length !== byId.size) {
    const stuck = [...byId.values()].filter((command) => !emitted.has(command.id)).sort(compare);
    problems.push({ severity: "error", code: "COMMAND_CYCLE", message: `The import produced circular dependencies involving ${stuck.slice(0, 3).map((command) => command.sourceId).join(", ")}.`, source: null });
    ordered.push(...stuck);
  }
  return { commands: ordered.map(({ rank: _rank, ...command }) => command), problems };
}

function compare(left: OrderableCommand, right: OrderableCommand): number { return left.effectiveDate.localeCompare(right.effectiveDate) || left.rank - right.rank || collator.compare(left.sourceId, right.sourceId) || left.id.localeCompare(right.id) }
class MinHeap<T> {
  private readonly values: T[] = [];
  constructor(private readonly compareValues: (left: T, right: T) => number) {}
  get size(): number { return this.values.length }
  push(value: T): void { this.values.push(value); for (let i = this.values.length - 1; i > 0;) { const parent = Math.floor((i - 1) / 2); if (this.compareValues(this.values[parent]!, value) <= 0) break; this.values[i] = this.values[parent]!; i = parent; this.values[i] = value; } }
  pop(): T | undefined { const first = this.values[0]; const last = this.values.pop(); if (this.values.length && last !== undefined) { this.values[0] = last; for (let i = 0;;) { const left = i * 2 + 1; const right = left + 1; let smallest = i; if (left < this.values.length && this.compareValues(this.values[left]!, this.values[smallest]!) < 0) smallest = left; if (right < this.values.length && this.compareValues(this.values[right]!, this.values[smallest]!) < 0) smallest = right; if (smallest === i) break; [this.values[i], this.values[smallest]] = [this.values[smallest]!, this.values[i]!]; i = smallest; } } return first }
}
