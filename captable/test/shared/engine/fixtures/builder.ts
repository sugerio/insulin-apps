import * as e from "../../../../src/app/shared/engine/index.ts";

/**
 * Builds synthetic ledgers for the tests the way the ledger writer will: commands claim contiguous seqs, transactions
 * are decoded through their payload schemas, and each row gets its canonical payload text, payload hash and chain link.
 * Ids are deterministic UUIDs derived from readable labels ("OPT-1", "S04"), so failures name the object.
 */

export function uuid(label: string): string {
  const hex = e.sha256Hex(`synthetic:${label}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface TxColumns {
  securityId?: string | null;
  stakeholderId?: string | null;
  stockClassId?: string | null;
  stockPlanId?: string | null;
  valuationId?: string | null;
  quantity?: string | null;
  amount?: string | null;
  currency?: string | null;
}

export interface CommandOptions {
  type?: string;
  actorKind?: e.ActorKind;
  source?: e.TransactionSource;
}

export class CommandBuilder {
  readonly transactions: e.LedgerTransaction[] = [];

  constructor(
    private readonly ledger: LedgerBuilder,
    readonly id: string,
    readonly source: e.TransactionSource,
  ) {}

  /** Adds a security identity created by this command. */
  security(label: string, identity: Omit<e.SecurityIdentity, "id" | "originCommandId" | "displayId"> & { displayId?: string }): string {
    const id = uuid(label);
    this.ledger.reference.securities.push({ ...identity, id, displayId: identity.displayId ?? label, originCommandId: this.id });
    return id;
  }

  tx<T extends e.TransactionTypeCode>(type: T, effectiveDate: string, payload: e.PayloadOf<T> | Record<string, unknown>, columns: TxColumns = {}): string {
    const p = payload as Record<string, unknown>;
    const str = (key: string) => (typeof p[key] === "string" ? (p[key] as string) : null);
    const fmv = p.x_fmv as { valuation_id?: string | null } | undefined;
    const money = p.amount as { amount?: string; currency?: string } | undefined;
    const seq = this.ledger.nextSeq();
    const id = uuid(`tx:${seq}:${this.id}`);
    const tx = e.decodeTransaction({
      id,
      seq,
      commandId: this.id,
      type,
      effectiveDate,
      payload,
      securityId: columns.securityId !== undefined ? columns.securityId : str("security_id"),
      stakeholderId: columns.stakeholderId !== undefined ? columns.stakeholderId : str("stakeholder_id"),
      stockClassId: columns.stockClassId !== undefined ? columns.stockClassId : str("stock_class_id"),
      stockPlanId: columns.stockPlanId !== undefined ? columns.stockPlanId : str("stock_plan_id"),
      valuationId: columns.valuationId !== undefined ? columns.valuationId : (fmv?.valuation_id ?? null),
      quantity: columns.quantity !== undefined ? columns.quantity : str("quantity"),
      amount: columns.amount !== undefined ? columns.amount : typeof money === "object" ? (money.amount ?? null) : null,
      currency: columns.currency !== undefined ? columns.currency : typeof money === "object" ? (money.currency ?? null) : null,
      reversesTxId: type === "X_REVERSAL" ? str("reverses_tx_id") : null,
      supersedesTxId: type === "X_CORRECTION" ? str("supersedes_tx_id") : null,
      source: this.source,
    });
    this.transactions.push(tx);
    this.ledger.append(tx, this.source);
    return id;
  }
}

export class LedgerBuilder {
  readonly orgId: string;
  readonly reference: {
    orgId: string;
    shareUnit: string;
    securities: e.SecurityIdentity[];
    stockClasses: e.StockClassRef[];
    stockPlans: e.StockPlanRef[];
    stakeholders: e.StakeholderRef[];
    vestingTerms: e.VestingTermsRef[];
    commands: e.LedgerCommand[];
  };
  readonly transactions: e.LedgerTransaction[] = [];
  readonly rows: e.TransactionRow[] = [];
  readonly commandIds = new Map<string, string>();
  private seq = 0;
  private head: string;
  private clock = Date.UTC(2026, 9, 1);

  constructor(options: { orgId?: string; shareUnit?: string } = {}) {
    this.orgId = options.orgId ?? uuid("org:acme");
    this.head = e.genesisHash(this.orgId);
    this.reference = {
      orgId: this.orgId,
      shareUnit: options.shareUnit ?? "1",
      securities: [],
      stockClasses: [],
      stockPlans: [],
      stakeholders: [],
      vestingTerms: [],
      commands: [],
    };
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  get headSeq(): number {
    return this.seq;
  }

  append(tx: e.LedgerTransaction, source: e.TransactionSource): void {
    this.clock += 1000;
    const row = e.buildTransactionRow(tx, { orgId: this.orgId, recordedAt: this.clock, recordedBy: null }, this.head);
    this.head = row.chain_hash;
    this.rows.push(row);
    this.transactions.push(tx);
  }

  stakeholder(label: string, relationship: e.Relationship, extra: Partial<e.StakeholderRef> = {}): string {
    const id = uuid(label);
    this.reference.stakeholders.push({ id, relationship, ...extra });
    return id;
  }

  stockClass(label: string, classType: "COMMON" | "PREFERRED", name = label): string {
    const id = uuid(label);
    this.reference.stockClasses.push({ id, name, classType });
    return id;
  }

  plan(label: string, stockClassId: string, name = label): string {
    const id = uuid(label);
    this.reference.stockPlans.push({ id, name, stockClassId });
    return id;
  }

  vestingTerms(label: string, definition: e.VestingDefinition): { id: string; sha: string } {
    const id = uuid(label);
    const sha = e.definitionSha256(definition);
    this.reference.vestingTerms.push({ id, definition, definitionSha256: sha });
    return { id, sha };
  }

  /** Runs `build` as one command: its transactions take contiguous seqs, and the command row records the range. */
  command(label: string, build: (c: CommandBuilder) => void, options: CommandOptions = {}): string {
    const id = uuid(`command:${label}`);
    const source = options.source ?? "import";
    const firstSeq = this.seq + 1;
    const builder = new CommandBuilder(this, id, source);
    build(builder);
    if (builder.transactions.length === 0) throw new Error(`Command ${label} wrote nothing`);
    this.reference.commands.push({
      id,
      type: options.type ?? label.split(":")[0]!,
      actorKind: options.actorKind ?? (source === "import" ? "import" : source === "system" ? "system" : "user"),
      reversesCommandId: null,
      firstSeq,
      lastSeq: this.seq,
      declaredTxCount: builder.transactions.length,
      createdAt: this.clock,
    });
    this.commandIds.set(label, id);
    return id;
  }

  /** A reverse-command: one X_REVERSAL per transaction of the target command, newest first. */
  reverse(targetLabelOrId: string, date: string): string {
    const targetId = this.commandIds.get(targetLabelOrId) ?? targetLabelOrId;
    const targets = this.transactions.filter((tx) => tx.commandId === targetId).sort((a, b) => b.seq - a.seq);
    const id = uuid(`command:reverse:${targetId}`);
    const firstSeq = this.seq + 1;
    const builder = new CommandBuilder(this, id, "app");
    for (const target of targets) builder.tx("X_REVERSAL", date, { reverses_tx_id: target.id });
    this.reference.commands.push({
      id,
      type: "reverse-command",
      actorKind: "user",
      reversesCommandId: targetId,
      firstSeq,
      lastSeq: this.seq,
      declaredTxCount: targets.length,
      createdAt: this.clock,
    });
    return id;
  }

  replay(asOf: string, options: { asKnownAt?: number | null; today?: string | null } = {}): e.LedgerState {
    return e.replay(this.reference, this.transactions, { asOf, ...options });
  }
}

/** Plain USD money. */
export function usd(amount: string): e.Monetary {
  return { amount, currency: "USD" };
}

/** Pulley-style explicit events from a monthly schedule (an oracle independent of the engine's generator). */
export function monthlyEvents(total: bigint, start: string, months: number, cliff: number, frequency = 1): { date: string; quantity: string }[] {
  const events: { date: string; quantity: string }[] = [];
  let previous = 0n;
  for (let k = frequency; k <= months; k += frequency) {
    if (k < cliff) continue;
    const cumulative = k === months ? total : (total * BigInt(k)) / BigInt(months);
    const quantity = cumulative - previous;
    if (quantity > 0n) events.push({ date: e.addMonths(start, k), quantity: quantity.toString() });
    previous = cumulative;
  }
  return events;
}
