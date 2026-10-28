import { describe, expect, it } from "vitest";
import {
  buildTransactionRow,
  decodeTransaction,
  EngineError,
  genesisHash,
  isCanonicalJsonText,
  parseCommandRow,
  parsePayload,
  parseTransactionRow,
  payloadSha256,
  TRANSACTION_TYPE_CODES,
  type TransactionTypeCode,
} from "../../../src/app/shared/engine/index.ts";
import { uuid } from "./fixtures/builder.ts";
import { SAMPLE_PAYLOADS } from "./fixtures/payloads.ts";

const ORG = uuid("org:acme");

/** Engine input for a sample payload, its denormalized columns filled from the payload as the writer fills them. */
function input(type: TransactionTypeCode, payload: Record<string, unknown> = SAMPLE_PAYLOADS[type], extra: Record<string, unknown> = {}) {
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  const money = payload.amount as { amount?: string; currency?: string } | undefined;
  const columns = {
    securityId: str(payload.security_id),
    stakeholderId: str(payload.stakeholder_id),
    stockClassId: str(payload.stock_class_id),
    stockPlanId: str(payload.stock_plan_id),
    quantity: str(payload.quantity),
    valuationId: str((payload.x_fmv as { valuation_id?: unknown } | undefined)?.valuation_id),
    amount: typeof money === "object" ? str(money.amount) : null,
    currency: typeof money === "object" ? str(money.currency) : null,
  };
  return { id: uuid(`t:${type}`), seq: 1, commandId: uuid("c:1"), type, effectiveDate: "2026-10-21", payload, source: "app" as const, ...columns, ...extra };
}

describe("payload schemas", () => {
  it("accept a valid payload for every type", () => {
    for (const type of TRANSACTION_TYPE_CODES) expect(() => parsePayload(type, SAMPLE_PAYLOADS[type]), type).not.toThrow();
  });

  it("are strict: an unknown key fails", () => {
    for (const type of TRANSACTION_TYPE_CODES) {
      expect(() => parsePayload(type, { ...SAMPLE_PAYLOADS[type], surprise: 1 }), type).toThrow(EngineError);
    }
  });

  it("refuse non-canonical decimals, bad dates and bad ids", () => {
    const issuance = SAMPLE_PAYLOADS.TX_STOCK_ISSUANCE;
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...issuance, quantity: "100.0" })).toThrow(/quantity/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...issuance, quantity: "0" })).toThrow(/greater than 0/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...issuance, quantity: 100 })).toThrow(EngineError);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...issuance, board_approval_date: "2026-02-30" })).toThrow(/date/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...issuance, security_id: "OPT-1" })).toThrow(/UUID/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...issuance, share_price: { amount: "1", currency: "usd" } })).toThrow(EngineError);
  });

  it("enforce the cross-field rules", () => {
    const stock = SAMPLE_PAYLOADS.TX_STOCK_ISSUANCE;
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, vesting_terms_id: uuid("vt") })).toThrow(/x_definition_sha256/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, x_origin: "EXERCISE" })).toThrow(/x_source_security_id/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, x_source_security_id: uuid("x") })).toThrow(/x_source_security_id/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, x_portion: "ISO" })).toThrow(/x_portion/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, x_origin: "EXERCISE", x_source_security_id: uuid("x"), x_portion: "ISO" })).not.toThrow();
    const grant = SAMPLE_PAYLOADS.TX_EQUITY_COMPENSATION_ISSUANCE;
    const { exercise_price: _price, ...noPrice } = grant;
    expect(() => parsePayload("TX_EQUITY_COMPENSATION_ISSUANCE", noPrice)).toThrow(/exercise price/);
    expect(() => parsePayload("TX_EQUITY_COMPENSATION_ISSUANCE", { ...noPrice, compensation_type: "RSU" })).not.toThrow();
    expect(() => parsePayload("TX_EQUITY_COMPENSATION_ISSUANCE", { ...noPrice, compensation_type: "CSAR" })).toThrow(/base price/);
    expect(() => parsePayload("TX_EQUITY_COMPENSATION_ISSUANCE", { ...grant, x_origin: "TRANSFER" })).toThrow(/x_source_security_id/);
    expect(() => parsePayload("TX_WARRANT_ISSUANCE", { ...SAMPLE_PAYLOADS.TX_WARRANT_ISSUANCE, x_origin: "BALANCE" })).toThrow(EngineError);
    expect(() => parsePayload("TX_CONVERTIBLE_ISSUANCE", { ...SAMPLE_PAYLOADS.TX_CONVERTIBLE_ISSUANCE, investment_amount: { amount: "0", currency: "USD" } })).toThrow(
      /principal/,
    );
    expect(() => parsePayload("X_SECURITY_MODIFICATION", { kind: "REPURCHASE_DEADLINE", security_id: uuid("s"), last_repurchase_date: "2026-12-14" })).not.toThrow();
    expect(() => parsePayload("X_SECURITY_MODIFICATION", { kind: "OTHER", security_id: uuid("s") })).toThrow(EngineError);
    expect(() => parsePayload("X_MIGRATION_OPENING_BALANCE", { security_id: uuid("s"), outstanding: "1" })).toThrow(/x_evidence/);
  });

  it("know only version 1", () => {
    expect(() => parsePayload("TX_STOCK_ACCEPTANCE", SAMPLE_PAYLOADS.TX_STOCK_ACCEPTANCE, 2)).toThrow(/version/);
  });
});

describe("imported issuance facts", () => {
  const legend = { legend_id: uuid("legend:1"), name: "Securities Act legend", text: "THE SHARES HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT OF 1933." };
  const migrated = { x_board_approval_not_recorded_in_pulley: true, x_legends: [legend] };

  it("are accepted on imported issuances only; an app transaction stays strict", () => {
    const stock = { ...SAMPLE_PAYLOADS.TX_STOCK_ISSUANCE, ...migrated, x_debt_cancelled: { amount: "250000", currency: "USD" } };
    expect(() => decodeTransaction(input("TX_STOCK_ISSUANCE", stock, { source: "import" }))).not.toThrow();
    for (const key of ["x_board_approval_not_recorded_in_pulley", "x_legends", "x_debt_cancelled"] as const) {
      const onlyOne = { ...SAMPLE_PAYLOADS.TX_STOCK_ISSUANCE, [key]: stock[key] };
      expect(() => decodeTransaction(input("TX_STOCK_ISSUANCE", onlyOne)), key).toThrow(new RegExp(`${key} only come from an import`));
    }
    const award = { ...SAMPLE_PAYLOADS.TX_EQUITY_COMPENSATION_ISSUANCE, ...migrated };
    expect(() => decodeTransaction(input("TX_EQUITY_COMPENSATION_ISSUANCE", award, { source: "import" }))).not.toThrow();
    expect(() => decodeTransaction(input("TX_EQUITY_COMPENSATION_ISSUANCE", award, { source: "system" }))).toThrow(/only come from an import/);
    const warrant = { ...SAMPLE_PAYLOADS.TX_WARRANT_ISSUANCE, ...migrated, x_debt_cancelled: { amount: "1000", currency: "USD" } };
    expect(() => decodeTransaction(input("TX_WARRANT_ISSUANCE", warrant, { source: "import" }))).not.toThrow();
    const safe = { ...SAMPLE_PAYLOADS.TX_CONVERTIBLE_ISSUANCE, x_board_approval_not_recorded_in_pulley: true };
    expect(() => decodeTransaction(input("TX_CONVERTIBLE_ISSUANCE", safe, { source: "import" }))).not.toThrow();
    // Options carry no debt cancelled, and a SAFE no legends: those keys stay unknown there.
    expect(() => parsePayload("TX_EQUITY_COMPENSATION_ISSUANCE", { ...award, x_debt_cancelled: { amount: "1", currency: "USD" } })).toThrow(EngineError);
    expect(() => parsePayload("TX_CONVERTIBLE_ISSUANCE", { ...safe, x_legends: [legend] })).toThrow(EngineError);
  });

  it("can't record a board approval date and an import omission together, or a legend without its text", () => {
    const stock = SAMPLE_PAYLOADS.TX_STOCK_ISSUANCE;
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, board_approval_date: "2024-01-01", x_board_approval_not_recorded_in_pulley: true })).toThrow(/exclude each other/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, x_board_approval_not_recorded_in_pulley: false })).toThrow(EngineError); // only `true` is a fact
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, x_legends: [{ legend_id: legend.legend_id, name: legend.name }] })).toThrow(/text/);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, x_legends: [{ ...legend, extra: 1 }] })).toThrow(EngineError);
    expect(() => parsePayload("TX_STOCK_ISSUANCE", { ...stock, x_legends: [] })).toThrow(EngineError);
  });
});

describe("decoding transactions", () => {
  it("decodes engine input whose columns mirror the payload, and fills absent columns with null", () => {
    const tx = decodeTransaction(input("TX_STOCK_ACCEPTANCE"));
    expect(tx.securityId).toBe((SAMPLE_PAYLOADS.TX_STOCK_ACCEPTANCE as { security_id: string }).security_id);
    expect([tx.stakeholderId, tx.quantity, tx.valuationId, tx.amount, tx.currency]).toEqual([null, null, null, null, null]);
    expect(tx.payloadVersion).toBe(1);
    expect(tx.reversesTxId).toBeNull();
    const plain = decodeTransaction({ id: uuid("t:plain"), seq: 1, commandId: uuid("c:1"), type: "X_STAKEHOLDER_LEAVE", effectiveDate: "2026-10-21", payload: SAMPLE_PAYLOADS.X_STAKEHOLDER_LEAVE, stakeholderId: (SAMPLE_PAYLOADS.X_STAKEHOLDER_LEAVE as { stakeholder_id: string }).stakeholder_id, source: "app" });
    expect(plain.securityId).toBeNull(); // an absent column is null
  });

  it("refuses unknown types, bad dates and bad seqs", () => {
    expect(() => decodeTransaction({ ...input("TX_STOCK_ACCEPTANCE"), type: "TX_NOPE" as TransactionTypeCode })).toThrow(/Unknown transaction type/);
    expect(() => decodeTransaction(input("TX_STOCK_ACCEPTANCE", undefined, { effectiveDate: "2026-13-01" }))).toThrow(/effective date/);
    expect(() => decodeTransaction(input("TX_STOCK_ACCEPTANCE", undefined, { seq: 0 }))).toThrow(/seq/);
  });

  it("refuses columns that disagree with the payload, in both directions", () => {
    const issuance = SAMPLE_PAYLOADS.TX_STOCK_ISSUANCE;
    expect(() => decodeTransaction(input("TX_STOCK_ISSUANCE", issuance, { securityId: uuid("other") }))).toThrow(/column security_id differs/);
    expect(() => decodeTransaction(input("TX_STOCK_ISSUANCE", issuance, { quantity: "99" }))).toThrow(/column quantity differs/);
    expect(() => decodeTransaction(input("TX_STOCK_ISSUANCE", issuance, { stakeholderId: uuid("other") }))).toThrow(/stakeholder_id/);
    // A null column the payload has a value for, and a stray column the payload doesn't explain.
    expect(() => decodeTransaction(input("TX_STOCK_ISSUANCE", issuance, { securityId: null }))).toThrow(/column security_id is empty, but the payload has the field/);
    expect(() => decodeTransaction(input("TX_STOCK_ISSUANCE", issuance, { stockPlanId: uuid("plan") }))).toThrow(/column stock_plan_id is set, but the payload has no such field/);
    expect(() => decodeTransaction(input("TX_STOCK_ACCEPTANCE", undefined, { quantity: "1" }))).toThrow(/column quantity is set/);
    const exercise = { ...SAMPLE_PAYLOADS.TX_EQUITY_COMPENSATION_EXERCISE, x_fmv: { price_per_share: { amount: "1", currency: "USD" }, valuation_id: uuid("V1"), source: "VALUATION" } };
    expect(() => decodeTransaction(input("TX_EQUITY_COMPENSATION_EXERCISE", exercise))).not.toThrow();
    expect(() => decodeTransaction(input("TX_EQUITY_COMPENSATION_EXERCISE", exercise, { valuationId: null }))).toThrow(/column valuation_id is empty/);
    expect(() => decodeTransaction(input("TX_EQUITY_COMPENSATION_EXERCISE", undefined, { valuationId: uuid("V1") }))).toThrow(/column valuation_id is set/);
    expect(() => decodeTransaction(input("TX_CONVERTIBLE_CANCELLATION"))).not.toThrow();
    expect(() => decodeTransaction(input("TX_CONVERTIBLE_CANCELLATION", undefined, { amount: null }))).toThrow(/column amount is empty/);
    expect(() => decodeTransaction(input("TX_CONVERTIBLE_CANCELLATION", undefined, { currency: "EUR" }))).toThrow(/column currency differs/);
    expect(() => decodeTransaction(input("TX_STOCK_ACCEPTANCE", undefined, { amount: "5", currency: "USD" }))).toThrow(/column amount is set/);
    expect(() => decodeTransaction(input("X_REVERSAL", undefined, { reversesTxId: uuid("other") }))).toThrow(/reverses_tx_id/);
    expect(() => decodeTransaction(input("X_REVERSAL"))).toThrow(/reverses_tx_id/);
    expect(() => decodeTransaction(input("TX_STOCK_ACCEPTANCE", undefined, { reversesTxId: uuid("t") }))).toThrow(/only X_REVERSAL/);
    expect(() => decodeTransaction(input("X_CORRECTION"))).toThrow(/supersedes_tx_id/);
    expect(() => decodeTransaction(input("TX_STOCK_ACCEPTANCE", undefined, { supersedesTxId: uuid("t") }))).toThrow(/only X_CORRECTION/);
    expect(() => decodeTransaction(input("X_STAKEHOLDER_TERMINATION", undefined, { effectiveDate: "2026-10-20" }))).toThrow(/effective date/);
    const reversal = SAMPLE_PAYLOADS.X_REVERSAL as { reverses_tx_id: string };
    expect(() => decodeTransaction(input("X_REVERSAL", undefined, { reversesTxId: reversal.reverses_tx_id }))).not.toThrow();
  });

  it("round-trips through a D1 row", () => {
    const tx = decodeTransaction(input("TX_STOCK_ISSUANCE", SAMPLE_PAYLOADS.TX_STOCK_ISSUANCE));
    const row = buildTransactionRow(tx, { orgId: ORG, recordedAt: 1, recordedBy: null }, genesisHash(ORG));
    expect(isCanonicalJsonText(row.payload)).toBe(true);
    expect(row.payload_sha256).toBe(payloadSha256(tx.payload));
    expect(parseTransactionRow(row)).toEqual(tx);
    expect(() => parseTransactionRow({ ...row, payload: "{oops" })).toThrow(/isn't JSON/);
    expect(() => parseTransactionRow({ ...row, type: "TX_NOPE" })).toThrow(/Unknown transaction type/);
  });

  it("maps command rows", () => {
    expect(
      parseCommandRow({ id: "c", type: "exercise-option", actor_kind: "user", reverses_command_id: null, first_seq: 3, last_seq: 5, declared_tx_count: 3, created_at: 9 }),
    ).toEqual({ id: "c", type: "exercise-option", actorKind: "user", reversesCommandId: null, firstSeq: 3, lastSeq: 5, declaredTxCount: 3, createdAt: 9 });
  });
});
