type Requirements = { prefix: string; minimumAgeSeconds: number };
type Result = { result: 'rejected' | 'unverified-candidate' };
const rejected: Result = { result: 'rejected' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Offline rejection screen only. No input to this function is authenticated cloud policy evidence. */
export function screenR2RetentionRules(config: unknown, requirements: Requirements): Result {
  if (!requirements || typeof requirements.prefix !== 'string' || !requirements.prefix || requirements.prefix.length > 1024 ||
      !Number.isSafeInteger(requirements.minimumAgeSeconds) || requirements.minimumAgeSeconds <= 0 ||
      !record(config) || !Array.isArray(config.rules) || config.rules.length > 1000) return rejected;
  let candidate = false;
  for (const rule of config.rules) {
    if (!record(rule) || typeof rule.enabled !== 'boolean' ||
        (rule.prefix !== undefined && typeof rule.prefix !== 'string') || !record(rule.condition)) return rejected;
    const condition = rule.condition;
    if (condition.type !== 'Indefinite' && (condition.type !== 'Age' || !Number.isSafeInteger(condition.maxAgeSeconds) || (condition.maxAgeSeconds as number) <= 0)) return rejected;
    const prefix = rule.prefix ?? '';
    if (rule.enabled && requirements.prefix.startsWith(prefix as string) &&
        (condition.type === 'Indefinite' || (condition.maxAgeSeconds as number) >= requirements.minimumAgeSeconds)) candidate = true;
  }
  return candidate ? { result: 'unverified-candidate' } : rejected;
}
