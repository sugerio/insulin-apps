import { api } from "#shared";

/** Admin masking is shared with the holder-preview read model so both surfaces reveal exactly the same suffix. */
export function maskPaymentAccount(value: string): string {
  if (value.length < 6) return "••••";
  if (value.length < 8) return `••••${value.slice(-2)}`;
  return `••••${value.slice(-4)}`;
}

export function maskPaymentInstructionDetails(
  details: api.PaymentInstructionDetails,
): api.PaymentInstructionDetails {
  const { iban, ...rest } = details;
  return {
    ...rest,
    accountNumber: maskPaymentAccount(rest.accountNumber),
    ...(iban !== undefined ? { iban: maskPaymentAccount(iban) } : {}),
  };
}

export function parsePaymentInstructionDetails(raw: string): api.PaymentInstructionDetails | null {
  try {
    const parsed = api.paymentInstructionDetailsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
