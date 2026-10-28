import "./setup.ts";
import { createHash } from "node:crypto";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { SEED_CLASS, VALUATIONS, stockClass } from "./support/acme.ts";
import { expectNotDismissible, field, keysOf, LOST, stage, unavailable, uploads } from "./support/flows.ts";
import { mock, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { ECHO } from "./support/securities.ts";
import { renderPage } from "./support/render.tsx";

// The document upload every flow uses. Choosing a file sends nothing: the type and size are checked, the
// SHA-256 is computed from the bytes (WebCrypto), and the upload is reviewed as exactly what it sends. "Upload" sends
// that frozen request with one Idempotency-Key; a lost answer keeps the bytes, headers and key until a retry or a check
// settles it, and nothing can close its dialog meanwhile. A header that changes after the review drops it.

const BYTES = "%PDF-1.7 synthetic report";
const pdf = (name: string, bytes = BYTES) => new File([bytes], name, { type: "application/pdf" });

function page(...extra: MockHandler[]) {
  const routes = new Set(extra.map((handler) => handler.route));
  return renderPage("compliance/409a/new", [
    ...extra,
    ...[mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS] }), mock(api.routes.listValuations, { items: VALUATIONS }), uploads()].filter((handler) => !routes.has(handler.route)),
  ], { role: "admin_rw" });
}

describe("document upload", () => {
  it("reviews what it will send before anything is sent, then sends the bytes' SHA-256, the encoded name and the kind", async () => {
    const { callsTo } = page();
    await screen.findByRole("heading", { name: "Record FMV", level: 1 });
    fireEvent.change(field(/Valuation report/), { target: { files: [pdf("Oct 2026 Valuation — final.pdf")] } });
    const review = await screen.findByLabelText("Upload of Oct 2026 Valuation — final.pdf");
    const digest = createHash("sha256").update(BYTES).digest("hex");
    await waitFor(() => expect(review.textContent).toContain(`Upload Oct 2026 Valuation — final.pdf (1 KiB, SHA-256 ${digest.slice(0, 10)}…) as Valuation report.`));
    // Nothing has been sent yet.
    expect(callsTo(api.routes.uploadDocument)).toHaveLength(0);
    fireEvent.click(within(review).getByRole("button", { name: "Upload Oct 2026 Valuation — final.pdf" }));
    expect(await screen.findByRole("button", { name: "Remove Oct 2026 Valuation — final.pdf" })).toBeTruthy();
    const call = callsTo(api.routes.uploadDocument)[0]!;
    expect(call.headers.get("x-content-sha256")).toBe(digest);
    expect(call.headers.get("x-filename")).toBe(encodeURIComponent("Oct 2026 Valuation — final.pdf"));
    expect(call.headers.get("x-document-kind")).toBe("VALUATION_REPORT");
    expect(call.headers.get("content-type")).toBe("application/pdf");
    expect(call.headers.get("x-link-target")).toBeNull();
    expect(call.headers.get("Idempotency-Key")).toBeTruthy();
    expect(screen.getByText(/SHA-256 [0-9a-f]{10}…/)).toBeTruthy();
  }, 60_000);

  it("states the contract's size limit, and refuses a larger file before anything is sent", async () => {
    const { callsTo } = page();
    await screen.findByRole("heading", { name: "Record FMV", level: 1 });
    const limit = `${api.LIMITS.uploadBytes / (1024 * 1024)} MiB`;
    expect(limit).toBe("10 MiB");
    expect(screen.getAllByText(new RegExp(`max ${limit}`)).length).toBeGreaterThan(0);
    const large = pdf("Board deck.pdf");
    Object.defineProperty(large, "size", { value: api.LIMITS.uploadBytes + 1 });
    fireEvent.change(field(/Valuation report/), { target: { files: [large] } });
    expect(await screen.findByText(`Board deck.pdf is larger than ${limit}.`)).toBeTruthy();
    expect(callsTo(api.routes.uploadDocument)).toHaveLength(0);
  }, 60_000);

  it("refuses a type the app doesn't store, and keeps a lost upload's bytes, headers and key until a retry settles it", async () => {
    let attempts = 0;
    const flaky = uploads();
    const upload = mock(api.routes.uploadDocument, (request: MockRequest) => (++attempts === 1 ? unavailable() : (flaky.respond as (request: MockRequest) => unknown)(request)));
    const { callsTo } = page(upload);
    await screen.findByRole("heading", { name: "Record FMV", level: 1 });
    fireEvent.change(field(/Valuation report/), { target: { files: [new File(["MZ"], "setup.exe", { type: "application/x-msdownload" })] } });
    expect(await screen.findByText("setup.exe: use a PDF, DOCX, XLSX, CSV, TXT, PNG or JPG file.")).toBeTruthy();
    stage(/Valuation report/, "Oct 2026 Valuation.pdf", BYTES);
    fireEvent.click(await screen.findByRole("button", { name: "Upload Oct 2026 Valuation.pdf" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    // Nothing about the upload can change until its outcome is known.
    expect(screen.queryByRole("button", { name: "Don't upload Oct 2026 Valuation.pdf" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Remove Oct 2026 Valuation.pdf" })).toBeTruthy();
    const calls = callsTo(api.routes.uploadDocument);
    expect(calls).toHaveLength(2);
    expect(keysOf(calls)[0]).toBe(keysOf(calls)[1]);
    expect(calls[1]!.headers.get("x-content-sha256")).toBe(calls[0]!.headers.get("x-content-sha256"));
  }, 60_000);

  it("after a lost upload, checks the stored documents: none with its checksum means nothing was stored", async () => {
    const upload = mock(api.routes.uploadDocument, () => unavailable());
    const list = mock(api.routes.listDocuments, { items: [], nextCursor: null });
    const { callsTo } = page(upload, list);
    await screen.findByRole("heading", { name: "Record FMV", level: 1 });
    stage(/Valuation report/, "Oct 2026 Valuation.pdf", BYTES);
    fireEvent.click(await screen.findByRole("button", { name: "Upload Oct 2026 Valuation.pdf" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check what was recorded" }));
    expect(await screen.findByText(/^The server has no record of it/)).toBeTruthy();
    expect(callsTo(api.routes.listDocuments)[0]!.query.get("kind")).toBe("VALUATION_REPORT");
    // Settled: another file may be chosen.
    expect(await screen.findByRole("button", { name: "Don't upload Oct 2026 Valuation.pdf" })).toBeTruthy();
  }, 60_000);
});

describe("an upload inside a dialog", () => {
  const documentsPage = (...extra: MockHandler[]) => renderPage("documents", [
    ...extra,
    mock(api.routes.listDocuments, { items: [], nextCursor: null }),
    mock(api.routes.listCollections, { items: [] }),
    mock(api.routes.listSecurities, { ...ECHO, items: [] }),
    mock(api.routes.listStakeholders, { ...ECHO, items: [] }),
    mock(api.routes.listStockPlans, { ...ECHO, items: [] }),
    mock(api.routes.listStockClasses, { ...ECHO, items: [] }),
    mock(api.routes.listValuations, { items: [] }),
  ], { role: "admin_rw" });

  it("can't be closed while the upload's outcome is unknown", async () => {
    documentsPage(mock(api.routes.uploadDocument, () => unavailable()));
    fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
    const dialog = await screen.findByRole("dialog", { name: "Upload a document" });
    stage(/^File/, "Q4 2026 board deck.pdf");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Upload Q4 2026 board deck.pdf" }));
    expect(await within(dialog).findByText(LOST)).toBeTruthy();
    expectNotDismissible("Upload a document");
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  }, 60_000);

  it("reviews the upload again when its type changes after the review", async () => {
    const { callsTo } = documentsPage(uploads());
    fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
    const dialog = await screen.findByRole("dialog", { name: "Upload a document" });
    stage(/^File/, "Board consent 2026-10-20.pdf");
    const review = await within(dialog).findByLabelText("Upload of Board consent 2026-10-20.pdf");
    await waitFor(() => expect(review.textContent).toContain("as Other."));
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "BOARD_CONSENT" } });
    // The reviewed upload no longer describes what would be sent: it is dropped and reviewed again.
    expect((await within(dialog).findAllByText("Review again")).length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole("button", { name: "Upload Board consent 2026-10-20.pdf" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Review the upload" }));
    await waitFor(() => expect(within(dialog).getByLabelText("Upload of Board consent 2026-10-20.pdf").textContent).toContain("as Board consent."));
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload Board consent 2026-10-20.pdf" }));
    await within(dialog).findByRole("button", { name: "Remove Board consent 2026-10-20.pdf" });
    expect(callsTo(api.routes.uploadDocument).map((call) => call.headers.get("x-document-kind"))).toEqual(["BOARD_CONSENT"]);
  }, 60_000);
});
