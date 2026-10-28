/**
 * The engine's version, part of the replay cache key (org, seq, head hash, ENGINE_VERSION) and of every replay hash
 * (the ledger rules). Bump it with any change that can move a number for some ledger, so cached states and recorded
 * hashes from the old engine are never mistaken for the new one's.
 */
export const ENGINE_VERSION = "1.0.0";
