import "./zod-config.ts";
import { z } from "zod";
import { epochMsSchema, ledgerSeqSchema, sha256HexSchema, uuidSchema } from "./primitives.ts";

/** Result of an on-demand ledger verification. */
export const ledgerVerificationSchema = z.object({
  orgId: uuidSchema,
  checkedAt: epochMsSchema,
  ledgerSeq: ledgerSeqSchema,
  ledgerHeadHash: sha256HexSchema.nullable(),
  ok: z.boolean(),
  checks: z.array(z.object({
    name: z.enum(["payload_hashes", "chain", "seals", "replay", "dependencies"]),
    ok: z.boolean(),
    problems: z.array(z.string()),
  })),
});
export type LedgerVerification = z.infer<typeof ledgerVerificationSchema>;
