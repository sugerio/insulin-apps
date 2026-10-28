/**
 * UUIDv7 (RFC 9562) for ledger rows (the ledger rules): a millisecond timestamp prefix, then randomness, so rows of one org
 * cluster in insertion order in the indexes. Lowercase, as the contract's UUID pattern requires.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = BigInt(Math.max(0, Math.floor(now)));
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
