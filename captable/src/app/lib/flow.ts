import { useCallback, useEffect, useRef, useState } from "react";
import type { api } from "#shared";
import { ApiError } from "../api/client.ts";
import { ApiRequestError, isAbortError, newIdempotencyKey } from "../api/request.ts";
import { describeError, type ErrorMessages } from "./errors.ts";
import { useWriteHold } from "./unsettled.ts";

// Every admin write follows one cycle:
// 1. "Review" freezes the request the form describes. The dry run (`?dryRun=true`, no key) previews exactly that
//    request, and the real call sends exactly that request again. Only what confirming adds is added: the reviewed seq
//    and diff, the warnings acknowledged, a typed confirmation. If anything the request depends on changes while the
//    preview is shown (an answer, or a lookup that finished late), the preview is dropped and the admin reviews again.
// 2. An Idempotency-Key belongs to one body. A retry of the same body reuses it; a changed body gets a new one.
// 3. A 422 shows its violations next to the fields they name. A stale answer (409) reloads what the request read,
//    builds it again and asks for a fresh review.
// 4. An ambiguous answer (network error, 5xx, an unreadable reply) may hide a recorded write. The body and its key stay
//    frozen: "Try again" resends them, and the server replays the recorded answer if there is one. Nothing can be
//    edited until the outcome is known, from a retry or from re-reading the server's state, and nothing can close the
//    write either: from the moment it is sent until it settles it holds the app (lib/unsettled), so its dialog can't be
//    dismissed and the page can't be left with its body and key.
// Reference-data writes (409A, stakeholders, their e-mails, payment instructions) have no dry run: their review is the form's summary of
// the frozen request, and the rest of the cycle is the same.

export type FlowPhase = "edit" | "previewing" | "review" | "committing" | "unresolved" | "done";

export interface Dependent {
  commandId: string;
  type: string;
  createdAt: number;
}

/** What went wrong, sorted by what the admin can do about it. */
export type FlowProblem =
  /** Fix the form: 400 issues and 422 violations, placed on their fields where the flow knows them. */
  | { kind: "invalid"; message: string; fields: Readonly<Record<string, string>>; unplaced: readonly string[] }
  /** Acknowledge each warning and confirm again (422 warnings_unacknowledged). */
  | { kind: "warnings"; warnings: readonly api.Warning[] }
  /** The ledger or the record moved since the review: the preview shown has been refreshed; confirm it again. */
  | { kind: "stale"; message: string }
  /** What the request depends on changed while its preview was shown: the preview was dropped; review again. */
  | { kind: "changed"; message: string }
  /** Nothing to retry here: self-dealing, a reversal with dependents, migrated history, a reused key. */
  | { kind: "blocked"; message: string; dependents?: readonly Dependent[] }
  /** Nothing was recorded (a refused dry run, a check that found nothing): try again. */
  | { kind: "failed"; message: string; retry: boolean }
  /** The answer was lost: the write may have been recorded. Retry with the same body and key, or check. */
  | { kind: "unresolved"; message: string; checked: boolean };

/** Where a flow shows what the server refused: a field name for an issue path or a violation, or null for "above the form". */
export interface FieldMap {
  issue?: (path: string) => string | null;
  violation?: (violation: api.Violation) => string | null;
}

/** What re-reading the server's state says about a write whose answer was lost. */
export type Reconciled<R = never> = "not_recorded" | "unknown" | { result: R };

const STALE_REASONS = new Set(["stale_ledger", "state_changed", "stale_version"]);

const STALE_MESSAGE = "The ledger changed since you reviewed this. The preview below has been refreshed: review it again before you confirm.";

export const CHANGED_MESSAGE = "Something the preview depends on changed after it was made (an answer, or a figure that finished loading). Nothing was recorded: review again.";

const UNRESOLVED_TAIL = "It may have been recorded. Try again: if it was, the server returns that result instead of recording it twice. Nothing can be changed until the outcome is known.";

function codeOf(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

function bodyOf(error: unknown): api.ApiErrorBody["error"] | null {
  return error instanceof ApiRequestError ? (error.body?.error ?? null) : null;
}

/**
 * Whether a failed call may still have been recorded: no answer (network), a server error, or an answer the client
 * couldn't read. A 4xx is a refusal: nothing was written, and no receipt was kept.
 */
export function isAmbiguous(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (!(error instanceof ApiError)) return true;
  return error.code === "network_error" || error.code === "internal" || error.code === "unavailable" || error.status === 0 || error.status >= 500;
}

/** Sorts a refused call into what the admin can do about it; `messages` words chosen error codes. */
export function classifyFailure(error: unknown, fields: FieldMap = {}, messages: ErrorMessages = {}): FlowProblem {
  const code = codeOf(error);
  const body = bodyOf(error);
  if (code === "validation_failed" || code === "invariant_violation") {
    const placed: Record<string, string> = {};
    const unplaced: string[] = [];
    const place = (field: string | null | undefined, message: string) => {
      if (field && !placed[field]) placed[field] = message;
      else if (!field) unplaced.push(message);
      else placed[field] = `${placed[field]} ${message}`;
    };
    for (const issue of body?.issues ?? []) place(fields.issue?.(issue.path), issue.message);
    for (const violation of body?.violations ?? []) place(fields.violation?.(violation), violation.message);
    if (!body?.issues?.length && !body?.violations?.length) unplaced.push(describeError(error, messages));
    return { kind: "invalid", message: code === "invariant_violation" ? "The server refused this. Fix what it names and review again." : "Check the highlighted fields.", fields: placed, unplaced };
  }
  if (code === "warnings_unacknowledged") return { kind: "warnings", warnings: body?.warnings ?? [] };
  if (code === "conflict") {
    const reason = error instanceof ApiError ? error.reason : null;
    if (reason && STALE_REASONS.has(reason)) return { kind: "stale", message: body?.message ?? STALE_MESSAGE };
    if (reason === "dependents_exist") return { kind: "blocked", message: body?.message ?? "Reverse the dependent commands first, newest first.", dependents: body?.dependents ?? [] };
    if (reason === "migrated_history") return { kind: "blocked", message: "Imported history can't be reversed in the app." };
    if (reason === "idempotency_key_reused") {
      return { kind: "blocked", message: "This was already submitted with different details, so nothing more was recorded. Reload the page to see what the ledger holds now." };
    }
    return { kind: "blocked", message: describeError(error, messages) };
  }
  if (code === "self_dealing") return { kind: "blocked", message: "Admins never record writes on their own holdings or stakeholder record — another admin must. Nothing was changed." };
  if (code === "not_found") {
    // A pending route and an unknown record both answer 404; this sentence is true of either.
    return { kind: "blocked", message: `Nothing was changed. The server couldn't find a record this refers to, or doesn't offer this action yet (${body?.message ?? "not found"}).` };
  }
  if (code === "forbidden" || code === "unauthenticated" || code === "payload_too_large" || code === "unsupported_media_type" || code === "digest_mismatch") {
    return { kind: "blocked", message: describeError(error, messages) };
  }
  // network_error, unavailable, internal. On a dry run nothing was written either way; on a real call
  // the flow turns an ambiguous one into "unresolved".
  return { kind: "failed", message: describeError(error, messages), retry: true };
}

/** JSON with sorted keys: two requests are the same request exactly when their canonical JSON is equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/**
 * The check for a ledger command whose answer was lost: preview the same request again. If the ledger head is still
 * the one the review showed, nothing was recorded (a recorded command moves the head). If it moved, it may be ours.
 */
export async function ledgerUnmoved(dryRun: () => Promise<{ ledgerSeq: number }>, reviewedSeq: number): Promise<Reconciled<never>> {
  try {
    const now = await dryRun();
    return now.ledgerSeq === reviewedSeq ? "not_recorded" : "unknown";
  } catch (error) {
    if (isAmbiguous(error)) throw error;
    // Refused now: the state moved since the review, perhaps by this very write.
    return "unknown";
  }
}

export interface WriteFlowSpec<Q, P, B, R> {
  /** The request the form describes. "Review" freezes it; the dry run and the real call both use the frozen copy. */
  request: () => Q;
  /** The dry run of the frozen request (or the reversal preview); null when the review is the form's own summary. */
  preview: ((request: Q, signal: AbortSignal) => Promise<P>) | null;
  /**
   * The real call's body: the frozen request, plus only what confirming adds (the reviewed seq and diff, the warnings
   * acknowledged, a typed confirmation or reason). Built once per attempt and kept, so a retry resends the same body.
   */
  body: (input: { request: Q; preview: P | null; acknowledge: readonly string[] }) => B;
  /** Sends a body with its Idempotency-Key. */
  send: (body: B, key: string) => Promise<R>;
  /** After a lost answer: re-reads the server's state. "not_recorded" unfreezes the form; "unknown" keeps it frozen. */
  reconcile?: (input: { request: Q; preview: P | null; body: B; key: string }) => Promise<Reconciled<R>>;
  fields?: FieldMap;
  /** Wording for chosen error codes in the problems shown (e.g. a four-eyes 403). */
  messages?: ErrorMessages;
  /** After a stale answer: reloads what the request read (a record, a version) before the request is built again. */
  refresh?: () => Promise<void>;
  onCommitted?: (result: R) => void;
}

export interface WriteFlow<Q, P, R> {
  phase: FlowPhase;
  /** The frozen request under review (null while editing). Review summaries show this, not the live form. */
  request: Q | null;
  preview: P | null;
  problem: FlowProblem | null;
  /** Shown above a preview that was refreshed after a stale answer. */
  staleNotice: string | null;
  /** The warnings to acknowledge: the preview's, plus any the real call raised. */
  warnings: readonly api.Warning[];
  acknowledged: ReadonlySet<string>;
  /** Every warning is acknowledged. */
  acknowledgedAll: boolean;
  result: R | null;
  busy: boolean;
  /** The reviewed request can no longer change: it is being sent, its outcome is unknown, or it is recorded. */
  locked: boolean;
  /** The outcome isn't known yet (being sent, being checked, or a lost answer): nothing may close this write. */
  unsettled: boolean;
  /** Whether "Check what was recorded" is offered for a lost answer. */
  canCheck: boolean;
  /** Freezes the request and runs the dry run, or moves to the local review. */
  review: () => Promise<void>;
  /** Sends the reviewed request; while unresolved, resends the same body with the same key. */
  commit: () => Promise<void>;
  /** After a lost answer: re-reads the server's state to learn whether anything was recorded. */
  check: () => Promise<void>;
  /** Back to the form (not while the outcome of an attempt is unknown): the next review is a new request. */
  edit: () => void;
  acknowledge: (code: string, accepted: boolean) => void;
  /** Clears a problem shown on the form (after the admin changed the field it named). */
  clearProblem: () => void;
}

function previewWarnings(preview: unknown): api.Warning[] {
  if (!preview || typeof preview !== "object") return [];
  const value = preview as { warnings?: unknown; preview?: { warnings?: unknown }; result?: { warnings?: unknown } };
  const list = Array.isArray(value.warnings) ? value.warnings
    : Array.isArray(value.preview?.warnings) ? value.preview.warnings
      : Array.isArray(value.result?.warnings) ? value.result.warnings : [];
  return list as api.Warning[];
}

interface Frozen<Q> {
  request: Q;
  json: string;
}

interface Attempt<B> {
  body: B;
  json: string;
  key: string;
}

/** The review → confirm cycle of one write, with the request frozen at review and each key bound to one body. */
export function useWriteFlow<Q, P, B, R>(spec: WriteFlowSpec<Q, P, B, R>): WriteFlow<Q, P, R> {
  const [phase, setPhase] = useState<FlowPhase>("edit");
  const [frozen, setFrozen] = useState<Frozen<Q> | null>(null);
  const [preview, setPreview] = useState<P | null>(null);
  const [problem, setProblem] = useState<FlowProblem | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [extraWarnings, setExtraWarnings] = useState<readonly api.Warning[]>([]);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<R | null>(null);
  const [checking, setChecking] = useState(false);
  /** Set after a stale answer: reviews again once the refreshed state has rendered (the request is built from it). */
  const [reviewAgain, setReviewAgain] = useState<string | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  const live = useRef({ phase, frozen, preview, acknowledged });
  live.current = { phase, frozen, preview, acknowledged };
  const attempt = useRef<Attempt<B> | null>(null);
  const controller = useRef<AbortController | null>(null);
  // Held from the moment a body is sent until its outcome is known (lib/unsettled).
  const hold = useWriteHold();

  const freeze = (next: Frozen<Q> | null) => {
    live.current.frozen = next;
    setFrozen(next);
  };

  const runReview = useCallback(async (notice: string | null) => {
    const current = specRef.current;
    controller.current?.abort();
    let request: Q;
    try {
      request = current.request();
    } catch (error) {
      freeze(null);
      setProblem(classifyFailure(error));
      setPhase("edit");
      return;
    }
    const next = { request, json: canonicalJson(request) };
    freeze(next);
    setPreview(null);
    setExtraWarnings([]);
    setAcknowledged(new Set());
    if (!current.preview) {
      setStaleNotice(notice);
      setProblem(notice ? { kind: "stale", message: notice } : null);
      setPhase("review");
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setPhase("previewing");
    setProblem(null);
    try {
      const answer = await current.preview(request, abort.signal);
      if (abort.signal.aborted) return;
      setPreview(answer);
      setStaleNotice(notice);
      setProblem(notice ? { kind: "stale", message: notice } : null);
      setPhase("review");
    } catch (error) {
      if (abort.signal.aborted || isAbortError(error)) return;
      freeze(null);
      setStaleNotice(null);
      setProblem(classifyFailure(error, current.fields, current.messages));
      setPhase("edit");
    }
  }, []);

  const review = useCallback(async () => {
    setProblem(null);
    await runReview(null);
  }, [runReview]);

  const commit = useCallback(async () => {
    const current = specRef.current;
    const { phase: now, frozen: reviewed, preview: shown, acknowledged: accepted } = live.current;
    if (!reviewed || now === "committing" || now === "done") return;
    let sending = attempt.current;
    if (now !== "unresolved" || !sending) {
      const body = current.body({ request: reviewed.request, preview: shown, acknowledge: [...accepted] });
      const json = canonicalJson(body);
      sending = attempt.current?.json === json ? attempt.current : { body, json, key: newIdempotencyKey() };
      attempt.current = sending;
    }
    hold(true);
    setPhase("committing");
    setProblem(null);
    try {
      const done = await current.send(sending.body, sending.key);
      attempt.current = null;
      // Settled before onCommitted, which may navigate to the result.
      hold(false);
      setResult(done);
      setPhase("done");
      current.onCommitted?.(done);
    } catch (error) {
      if (isAmbiguous(error)) {
        setProblem({ kind: "unresolved", message: `${describeError(error)} ${UNRESOLVED_TAIL}`, checked: false });
        setPhase("unresolved");
        return;
      }
      // A refusal leaves no receipt: nothing was recorded, and a corrected body gets its own key.
      attempt.current = null;
      hold(false);
      const failure = classifyFailure(error, current.fields, current.messages);
      if (failure.kind === "stale") {
        // Reload what the request read, then build it again and ask for a fresh review of a fresh preview.
        controller.current?.abort();
        freeze(null);
        setPreview(null);
        setPhase("previewing");
        try {
          await current.refresh?.();
        } catch {
          // The next review shows what the server says now; a failed reload surfaces there.
        }
        setReviewAgain(failure.message || STALE_MESSAGE);
        return;
      }
      if (failure.kind === "warnings") {
        setExtraWarnings(failure.warnings);
        setProblem(failure);
        setPhase("review");
        return;
      }
      if (failure.kind === "invalid") {
        freeze(null);
        setPreview(null);
        setProblem(failure);
        setPhase("edit");
        return;
      }
      setProblem(failure);
      setPhase("review");
    }
  }, []);

  const check = useCallback(async () => {
    const current = specRef.current;
    const { frozen: reviewed, preview: shown } = live.current;
    const sent = attempt.current;
    if (!current.reconcile || !reviewed || !sent || live.current.phase !== "unresolved") return;
    setChecking(true);
    try {
      const outcome = await current.reconcile({ request: reviewed.request, preview: shown, body: sent.body, key: sent.key });
      if (typeof outcome === "object") {
        attempt.current = null;
        hold(false);
        setResult(outcome.result);
        setPhase("done");
        current.onCommitted?.(outcome.result);
        return;
      }
      if (outcome === "not_recorded") {
        attempt.current = null;
        hold(false);
        setProblem({ kind: "failed", message: "The server has no record of it: nothing was recorded. Confirm again, or go back and change your answers.", retry: true });
        setPhase("review");
      } else {
        setProblem({ kind: "unresolved", message: `The server's state changed since your review, so it may be yours. ${UNRESOLVED_TAIL}`, checked: true });
      }
    } catch (error) {
      setProblem({ kind: "unresolved", message: `Couldn't check (${describeError(error)}). ${UNRESOLVED_TAIL}`, checked: false });
    } finally {
      setChecking(false);
    }
  }, []);

  const edit = useCallback(() => {
    if (live.current.phase === "committing" || live.current.phase === "unresolved") return;
    controller.current?.abort();
    freeze(null);
    setPreview(null);
    setProblem(null);
    setStaleNotice(null);
    setExtraWarnings([]);
    setAcknowledged(new Set());
    setPhase("edit");
  }, []);

  const acknowledge = useCallback((code: string, accepted: boolean) => {
    setAcknowledged((previous) => {
      const next = new Set(previous);
      if (accepted) next.add(code);
      else next.delete(code);
      return next;
    });
  }, []);

  // After a stale answer, review again once the refreshed state has rendered (the request is built from it).
  useEffect(() => {
    if (reviewAgain === null) return;
    setReviewAgain(null);
    void runReview(reviewAgain);
  }, [reviewAgain, runReview]);

  // The request the form describes now. While a preview is shown it must still be the frozen one: if an answer or a
  // late lookup changed it, the preview no longer describes what would be sent.
  let current: string | null = null;
  if ((phase === "previewing" || phase === "review") && frozen) {
    try {
      current = canonicalJson(spec.request());
    } catch {
      current = "\u0000unbuildable";
    }
  }
  const drifted = current !== null && frozen !== null && current !== frozen.json;
  useEffect(() => {
    if (!drifted) return;
    controller.current?.abort();
    freeze(null);
    setPreview(null);
    setExtraWarnings([]);
    setAcknowledged(new Set());
    setStaleNotice(null);
    setProblem({ kind: "changed", message: CHANGED_MESSAGE });
    setPhase("edit");
  }, [drifted]);

  const warnings = [...previewWarnings(preview), ...extraWarnings].filter((warning, index, all) => all.findIndex((other) => other.code === warning.code) === index);
  return {
    phase,
    request: frozen?.request ?? null,
    preview,
    problem,
    staleNotice,
    warnings,
    acknowledged,
    acknowledgedAll: warnings.every((warning) => acknowledged.has(warning.code)),
    result,
    busy: phase === "previewing" || phase === "committing" || checking,
    locked: phase === "committing" || phase === "unresolved" || phase === "done" || checking,
    unsettled: phase === "committing" || phase === "unresolved" || checking,
    canCheck: phase === "unresolved" && spec.reconcile !== undefined && !checking,
    review,
    commit,
    check,
    edit,
    acknowledge,
    clearProblem: () => setProblem(null),
  };
}

/** The message a problem shows on one field, if the server placed one there. */
export function fieldProblem(problem: FlowProblem | null, field: string): string | undefined {
  return problem?.kind === "invalid" ? problem.fields[field] : undefined;
}
