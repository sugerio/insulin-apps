/**
 * Whether `value` is a single plain email address that is safe as a mail header value: no
 * whitespace (so no line break, as in a header injection), no display name, angle brackets,
 * quotes or list separators, and at most 254 characters. Checked on MAIL_FROM and MAIL_SINK
 * (environment.ts, otp-mail-sink.ts) and on every recipient a code is sent to
 * (signing-routes.ts).
 */
export const isValidOtpEmailAddress = (value: string) => value.length <= 254 && /^[^\s@<>(),;:\\"\[\]]+@[^\s@<>(),;:\\"\[\]]+\.[^\s@<>(),;:\\"\[\]]+(?![\s\S])/.test(value);
