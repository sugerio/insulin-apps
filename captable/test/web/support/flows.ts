import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { api } from "#shared";
import { document, uuid } from "./acme.ts";
import { apiError, mock, type MockRequest } from "./mockApi.ts";

// The write-flow tests' shared pieces: command results the contract accepts, a command route that answers its dry run
// and its real calls in turn, the document upload, and the field helpers. Every body still passes the contract's
// schemas (mockApi), so a fixture can't drift from what the server may answer.

export const DIFF_A = "a1".repeat(32);
export const DIFF_B = "b2".repeat(32);
/** Effect hashes: what a command does, without the org-wide totals' absolute values. */
export const EFFECT_A = "e1".repeat(32);
export const EFFECT_B = "e2".repeat(32);
export const HEAD_HASH = "ab".repeat(32);

/** A CommandResult; a real call's has a command id and transaction ids. */
export function result(overrides: Partial<api.CommandResult> = {}, real = false): api.CommandResult {
  return api.commandResultSchema.parse({
    commandId: real ? uuid(30, 1) : null,
    dryRun: !real,
    ledgerSeq: real ? 413 : 412,
    ledgerHeadHash: HEAD_HASH,
    transactions: [],
    created: { securityIds: [], scheduledTerminationIds: [], vestingTermsIds: [] },
    changes: [],
    diffSha256: DIFF_A,
    effectSha256: EFFECT_A,
    dependencies: [],
    violations: [],
    warnings: [],
    ...overrides,
  });
}

type Responder = unknown | ((request: MockRequest) => unknown);

/** Answers a route's dry runs and real calls from two queues; the last answer of each repeats. */
export function commandRoute(route: api.AnyRoute, answers: { preview?: Responder | Responder[]; commit?: Responder | Responder[] }) {
  const queues = { preview: [answers.preview ?? []].flat(), commit: [answers.commit ?? []].flat() };
  const take = (kind: "preview" | "commit", request: MockRequest) => {
    const queue = queues[kind];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === "function" ? (next as (request: MockRequest) => unknown)(request) : next;
  };
  return mock(route, (request: MockRequest) => take(request.query.get("dryRun") === "true" ? "preview" : "commit", request));
}

/** Answers every upload with a stored document named as the browser sent it. */
export function uploads() {
  let n = 0;
  return mock(api.routes.uploadDocument, (request: MockRequest) => {
    n += 1;
    return document({
      id: uuid(40, n), filename: decodeURIComponent(request.headers.get("x-filename") ?? "file.pdf"), kind: (request.headers.get("x-document-kind") ?? "OTHER") as api.DocumentKind,
      contentType: "application/pdf", byteSize: 184_320, sha256: request.headers.get("x-content-sha256") ?? "cd".repeat(32), source: "upload",
      importedFromPulley: false, uploadedBy: "Morgan Ellis",
    });
  });
}

export const stale = () => apiError(409, "conflict", "The ledger moved since you reviewed this; review it again", { reason: "stale_ledger" });
export const staleVersion = () => apiError(409, "conflict", "It changed since you loaded it; reload it", { reason: "stale_version" });
export const unavailable = () => apiError(503, "unavailable", "D1 is unavailable");
export const refused = (violations: { code: string; message: string; securityId?: string }[]) => apiError(422, "invariant_violation", "The engine refused the command", { violations });
export const toAcknowledge = (warnings: { code: string; message: string }[]) => apiError(422, "warnings_unacknowledged", "Acknowledge the warnings", { warnings });

/** The input a label names (labels may carry the required marker). */
export function field(label: string | RegExp): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

export function type(label: string | RegExp, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

export function choose(label: string | RegExp, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

/** The error shown with a field: the element its aria-describedby names first. */
export function errorOf(label: string | RegExp): string {
  const input = field(label);
  const ids = input.getAttribute("aria-describedby")?.split(" ") ?? [];
  const error = ids.map((id) => document_(id)).find((element) => element?.className.includes("err"));
  return error?.textContent ?? "";
}

function document_(id: string): HTMLElement | null {
  return window.document.getElementById(id);
}

/** Chooses a file for a document field and waits until the upload answered. */
/** The banner after an ambiguous answer to a real call (network error, 5xx). */
export const LOST = "The answer was lost — the outcome is unknown";

/** A body without what only confirming adds (the reviewed seq and diff, the acknowledgements, a typed confirmation). */
export function asReviewed(body: unknown): Record<string, unknown> {
  const { expectedLedgerSeq: _seq, expectedDiffSha256: _diff, acknowledge: _acknowledge, confirmation: _confirmation, ...rest } = body as Record<string, unknown>;
  return rest;
}

/**
 * A dialog whose write is unsettled can't be dismissed: Escape, the backdrop and the close button leave it open (with
 * its body and key). Returns the dialog for further checks.
 */
export function expectNotDismissible(name: string | RegExp): HTMLElement {
  const dialog = screen.getByRole("dialog", { name });
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent.mouseDown(dialog.parentElement!);
  const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
  expect(close.disabled).toBe(true);
  fireEvent.click(close);
  expect(screen.getByRole("dialog", { name })).toBe(dialog);
  return dialog;
}

/** The real call sent exactly the request the dry run previewed (the request is frozen at review). */
export function expectSentAsPreviewed(dryRun: MockRequest, real: MockRequest) {
  expect(asReviewed(real.body)).toEqual(asReviewed(dryRun.body));
}

/**
 * Chooses a file for a document field, then confirms its reviewed upload ("Upload"), and waits until it is stored.
 * Choosing a file alone sends nothing (DocumentUpload stages it and shows the upload for review).
 */
export async function attach(label: string | RegExp, filename: string, bytes = "%PDF-1.7 synthetic") {
  stage(label, filename, bytes);
  fireEvent.click(await screen.findByRole("button", { name: `Upload ${filename}` }));
  await waitFor(() => expect(screen.queryByRole("button", { name: `Upload ${filename}` })).toBeNull());
  await screen.findByText(filename);
}

/** Chooses a file for a document field: it is read and checksummed in the browser, and its upload shown for review. */
export function stage(label: string | RegExp, filename: string, bytes = "%PDF-1.7 synthetic") {
  fireEvent.change(field(label), { target: { files: [new File([bytes], filename, { type: "application/pdf" })] } });
}

/** The Idempotency-Key of each call. */
export function keysOf(calls: readonly MockRequest[]): (string | null)[] {
  return calls.map((call) => call.headers.get("Idempotency-Key"));
}

export const dryRuns = (calls: readonly MockRequest[]) => calls.filter((call) => call.query.get("dryRun") === "true");
export const realCalls = (calls: readonly MockRequest[]) => calls.filter((call) => call.query.get("dryRun") !== "true");

/** Waits for a route to have been called `count` times. */
export async function waitForCalls(get: () => readonly MockRequest[], count: number) {
  await waitFor(() => expect(get()).toHaveLength(count));
}

export function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}
