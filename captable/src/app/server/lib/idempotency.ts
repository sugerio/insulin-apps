import type { Context } from "hono";
import { ApiError } from "./http.ts";
import { findIdempotency, idempotencyInsert, requestHash, type IdempotencyRow } from "./documents/model.ts";
import type { AppEnv } from "../types.ts";

export interface IdempotencyContext {
  scope: string;
  actor: string;
  route: string;
  key: string;
  requestHash: string;
  replay: Response | null;
}

function receiptResponse(row: IdempotencyRow, replay: boolean): Response {
  const empty = row.response_status === 204 || row.response_status === 205 || row.response_status === 304;
  return new Response(empty ? null : row.response_body, {
    status: row.response_status,
    headers: {
      ...(empty ? {} : { "Content-Type": "application/json" }),
      ...(replay ? { "Idempotent-Replay": "true" } : {}),
    },
  });
}

function compareReceipt(row: IdempotencyRow, hash: string): Response {
  if (row.request_sha256 !== hash) {
    throw new ApiError("conflict", "Idempotency-Key was already used for a different request", undefined, {
      reason: "idempotency_key_reused",
    });
  }
  return receiptResponse(row, true);
}

/** Re-check after a post-lookup state refusal so an overlapping winner is returned instead of a false conflict. */
export async function recoverIdempotency(
  db: D1Database,
  mutation: IdempotencyContext,
  operation: () => Promise<Response>,
): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    const row = await findIdempotency(db, mutation.scope, mutation.actor, mutation.route, mutation.key);
    if (row) return compareReceipt(row, mutation.requestHash);
    throw error;
  }
}

export async function prepareIdempotency(
  c: Context<AppEnv>,
  scope: string,
  route: string,
  body: unknown,
): Promise<IdempotencyContext> {
  const key = c.req.header("Idempotency-Key") ?? "";
  if (key.length < 8 || key.length > 200) {
    throw new ApiError("validation_failed", "Idempotency-Key must be 8–200 characters");
  }
  const actor = c.get("auth").user.id;
  const hash = await requestHash(c.req.method, c.req.path, [body]);
  const previous = await findIdempotency(c.env.DB, scope, actor, route, key);
  return { scope, actor, route, key, requestHash: hash, replay: previous ? compareReceipt(previous, hash) : null };
}

/** Adds the immutable receipt to the mutation batch and recovers a concurrent same-key winner as a replay. */
export async function commitIdempotent(
  db: D1Database,
  mutation: IdempotencyContext,
  statements: D1PreparedStatement[],
  status: number,
  body: unknown,
  now: number,
): Promise<Response | null> {
  const responseBody = JSON.stringify(body);
  try {
    await db.batch([
      ...statements,
      idempotencyInsert(db, {
        id: crypto.randomUUID(), scope: mutation.scope, actor: mutation.actor, route: mutation.route,
        key: mutation.key, requestHash: mutation.requestHash, status, body: responseBody, now,
      }),
    ]);
    return null;
  } catch (error) {
    const raced = await findIdempotency(db, mutation.scope, mutation.actor, mutation.route, mutation.key);
    if (raced) return compareReceipt(raced, mutation.requestHash);
    throw error;
  }
}

/** Commits a mutation whose response receipt is assembled by SQL from rows written in the same batch. */
export async function commitIdempotentWithReceipt(
  db: D1Database,
  mutation: IdempotencyContext,
  statements: D1PreparedStatement[],
  receipt: D1PreparedStatement,
): Promise<Response> {
  try {
    await db.batch([...statements, receipt]);
  } catch (error) {
    const raced = await findIdempotency(db, mutation.scope, mutation.actor, mutation.route, mutation.key);
    if (raced) return compareReceipt(raced, mutation.requestHash);
    throw error;
  }
  const stored = await findIdempotency(db, mutation.scope, mutation.actor, mutation.route, mutation.key);
  if (!stored) throw new Error("Committed idempotency receipt was not found");
  return receiptResponse(stored, false);
}
