import { transactionTypeInfo, type TransactionTypeCode } from "../engine/transaction-types.ts";
import { OCF_TRANSACTION_SCHEMAS, type OcfTransactionType } from "./keys.ts";

export * from "./keys.ts";
export * from "./version.ts";

/**
 * The payload key check of Appendix A: an OCF-typed transaction's payload may carry only the properties its OCF
 * object defines, plus app extensions under `x_`-prefixed keys. App-defined X_ types aren't checked against OCF.
 * Returns the offending keys (empty when the payload passes).
 */
export function ocfKeyViolations(type: TransactionTypeCode, payload: Record<string, unknown>): string[] {
  if (!transactionTypeInfo(type).isOcf) return [];
  const allowed = new Set<string>(OCF_TRANSACTION_SCHEMAS[type as OcfTransactionType].keys);
  return Object.keys(payload).filter((key) => !key.startsWith("x_") && !allowed.has(key));
}
