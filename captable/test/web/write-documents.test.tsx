import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, SEED_CLASS, VALUATIONS, securityList, stakeholderList, stockClass, stockPlan, uuid } from "./support/acme.ts";
import { attach, choose, errorOf, keysOf, LOST, refused, stage, staleVersion, type, unavailable, uploads } from "./support/flows.ts";
import { mock, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";
import { ECHO, securityHandlers } from "./support/securities.ts";

// Documents: the list and folders, a document's page and its writes (details,
// links, revocation, holder visibility, versions, archiving), and uploads from a record. Holder visibility follows the
// links: one holder's portal, nobody for several, and every holder for a company resource, published from the portal
// settings.

const DOC_ID = uuid(10, 50);
const FILE = "OPT-1 Option Agreement (executed).pdf";
const UPLOADED = Date.UTC(2026, 9, 20, 17);

function link(n: number, overrides: Partial<api.DocumentLink> = {}): api.DocumentLink {
  return { id: uuid(25, n), role: "AGREEMENT", targetType: "security", targetId: IDS.opt1, createdAt: UPLOADED, createdBy: "Morgan Ellis", revokedAt: null, revokeReason: null, ...overrides };
}

function doc(overrides: Partial<api.Document> = {}): api.Document {
  return api.documentSchema.parse({
    id: DOC_ID, filename: FILE, contentType: "application/pdf", byteSize: 184_320, sha256: "cd".repeat(32), kind: "GRANT_AGREEMENT", source: "upload",
    holderVisible: false, visibilityScope: "admins", collectionId: null, versionLabel: null, supersedesDocumentId: null, description: null, sourceCreatedAt: null,
    uploadedBy: "Morgan Ellis", createdAt: UPLOADED, archivedAt: null, links: [link(1)],
    importedFromPulley: false, version: 1,
    ...overrides,
  });
}

const detail = (document: api.Document): api.DocumentDetail => api.documentDetailSchema.parse({ ...document, versions: [{ id: document.id, versionLabel: document.versionLabel, createdAt: document.createdAt, supersedesDocumentId: document.supersedesDocumentId }] });

const FOLDER: api.DocumentCollection = { id: uuid(26, 1), kind: "FOLDER", name: "Board records", parentId: null, source: "app", archivedAt: null, createdAt: UPLOADED, version: 1 };
const TEMPLATES: api.DocumentCollection = { id: uuid(26, 2), kind: "TEMPLATE_GROUP", name: "Option grant templates", parentId: null, source: "pulley", archivedAt: null, createdAt: UPLOADED, version: 1 };

/** The names behind links, and the folders. */
const LOOKUPS: MockHandler[] = [
  mock(api.routes.listSecurities, securityList()),
  mock(api.routes.listStakeholders, stakeholderList()),
  mock(api.routes.listStockPlans, { ...ECHO, items: [stockPlan()] }),
  mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS] }),
  mock(api.routes.listValuations, { items: VALUATIONS }),
  mock(api.routes.listCollections, { items: [FOLDER, TEMPLATES] }),
];

/** One document as the server holds it now: a write changes it as the server would. */
function server(initial: api.Document) {
  const state = { current: initial };
  return { state, handler: mock(api.routes.getDocument, () => detail(state.current)) };
}

function documentPage(initial: api.Document, extra: MockHandler[] = [], options: Parameters<typeof renderPage>[2] = {}) {
  const held = server(initial);
  return { held, ...renderPage(`documents/${initial.id}`, [held.handler, ...extra, ...LOOKUPS], { role: "admin_rw", ...options }) };
}

async function action(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Actions" }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: new RegExp(`^${name}`) }));
}

describe("the documents list", () => {
  it("shows each document's links, type and visibility, filters on the server and loads more", async () => {
    const second = doc({ id: uuid(10, 51), filename: "Board consent 2026-09-04.pdf", kind: "BOARD_CONSENT", links: [link(2, { role: "CONSENT", targetType: "stock_plan", targetId: IDS.plan })], createdAt: UPLOADED - 86_400_000 });
    const list = mock(api.routes.listDocuments, (request: MockRequest) => (request.query.get("cursor") === "page-2"
      ? { items: [second], nextCursor: null }
      : { items: [doc({ holderVisible: true, visibilityScope: "holder" })], nextCursor: "page-2" }));
    const { callsTo } = renderPage("documents", [list, ...LOOKUPS], { role: "admin_rw" });
    const table = await screen.findByRole("table", { name: "Documents" });
    const row = within(table).getAllByRole("row").find((item) => within(item).queryByRole("link", { name: FILE }))!;
    await waitFor(() => expect(within(row).getByRole("link", { name: "OPT-1 · Daniel Achterberg" }).getAttribute("href")).toBe(`${base}/securities/${IDS.opt1}`));
    expect(within(row).getByText("The linked holder")).toBeTruthy();
    expect(within(row).getByText("Grant agreement")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more documents" }));
    expect(await within(table).findByRole("link", { name: "Board consent 2026-09-04.pdf" })).toBeTruthy();
    expect(within(table).getByRole("link", { name: "2023 Equity Incentive Plan" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by type" }), { target: { value: "BOARD_CONSENT" } });
    await waitFor(() => expect(callsTo(api.routes.listDocuments).at(-1)!.query.get("kind")).toBe("BOARD_CONSENT"));
    // Folders and migrated template groups are the server's filters; template groups are read-only.
    fireEvent.click(within(screen.getByRole("navigation", { name: "Folders" })).getByRole("link", { name: "Option grant templates" }));
    await waitFor(() => expect(callsTo(api.routes.listDocuments).at(-1)!.query.get("collectionId")).toBe(TEMPLATES.id));
    expect(await screen.findByText("A template group migrated from Pulley: read-only.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Rename the folder/ })).toBeNull();
  }, 60_000);

  it("gives read-only admins without PII no download and no write", async () => {
    renderPage("documents", [mock(api.routes.listDocuments, { items: [doc()], nextCursor: null }), ...LOOKUPS], { role: "admin_ro" });
    await screen.findByRole("table", { name: "Documents" });
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
    for (const name of ["Upload", "Create folder"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("creates a folder, opens it, and uploads into it", async () => {
    const created: api.DocumentCollection = { ...FOLDER, id: uuid(26, 9), name: "Q4 2026 board" };
    const create = mock(api.routes.createCollection, () => created);
    let folders = [FOLDER, TEMPLATES];
    const collections = mock(api.routes.listCollections, () => ({ items: folders }));
    const list = mock(api.routes.listDocuments, { items: [], nextCursor: null });
    const { callsTo, router } = renderPage("documents", [create, collections, list, uploads(), mock(api.routes.getDocument, (request: MockRequest) => detail(doc({ id: request.params.id!, filename: "Q4 2026 board deck.pdf", kind: "OTHER", links: [] }))), ...LOOKUPS], { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: "Create folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Create folder" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Folder name/)).toBe("Enter the folder's name.");
    type(/^Folder name/, "Q4 2026 board");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    folders = [FOLDER, TEMPLATES, created];
    fireEvent.click(within(dialog).getByRole("button", { name: "Create folder" }));
    expect(await screen.findByText("Folder Q4 2026 board created")).toBeTruthy();
    expect(callsTo(api.routes.createCollection)[0]!.body).toEqual({ name: "Q4 2026 board" });
    await waitFor(() => expect(router.state.location.search).toBe(`?folder=${created.id}`));
    expect(await screen.findByRole("heading", { name: "Q4 2026 board" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
    const upload = await screen.findByRole("dialog", { name: "Upload a document" });
    expect((within(upload).getByLabelText("Folder") as HTMLSelectElement).value).toBe(created.id);
    await attach(/^File/, "Q4 2026 board deck.pdf");
    expect(callsTo(api.routes.uploadDocument)[0]!.headers.get("x-collection-id")).toBe(created.id);
    fireEvent.click(within(upload).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/documents/${uuid(40, 1)}`));
  }, 60_000);
});

describe("a document's page", () => {
  it("edits the details with the version read", async () => {
    const patch = mock(api.routes.patchDocument, (request: MockRequest) => ({ ...doc(), description: "Executed on Oct 20", version: 2 }));
    const { callsTo } = documentPage(doc(), [patch]);
    await action("Edit details");
    const dialog = await screen.findByRole("dialog", { name: "Edit document details" });
    // The kinds kept for imported records are never offered.
    expect(within(within(dialog).getByLabelText("Type")).queryByRole("option", { name: "Reconciliation report" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^File name/)).toBe("Nothing has changed.");
    type("Description", "Executed on Oct 20");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain(`Save the description of ${FILE}.`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Document details saved")).toBeTruthy();
    expect(callsTo(api.routes.patchDocument)[0]!.body).toEqual({ version: 1, description: "Executed on Oct 20" });
  }, 60_000);

  it("keeps the details editable from the Actions menu", async () => {
    documentPage(doc());
    fireEvent.click(await screen.findByRole("button", { name: "Actions" }));
    const labels = within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.startsWith("Edit details"))).toBe(true);
  });

  it("refuses a second holder on a holder-visible document before sending, and links to a record", async () => {
    const visible = doc({ holderVisible: true, visibilityScope: "holder" });
    const add = mock(api.routes.addDocumentLink, (request: MockRequest) => ({ ...visible, links: [...visible.links, link(3, { role: "ATTACHMENT", targetType: "stock_class", targetId: IDS.common })] }));
    const { callsTo } = documentPage(visible, [add]);
    await action("Link to a record");
    const dialog = await screen.findByRole("dialog", { name: "Link to a record" });
    choose("Record type", "stakeholder");
    await within(dialog).findByRole("option", { name: "Freya Lindqvist" });
    choose(/^Record\*?$/, IDS.freya);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Record\*?$/)).toBe("A document holders can see is linked to one holder only. Hide it from the holder first, or upload a copy for the other holder.");
    choose("Record type", "stock_class");
    await within(dialog).findByRole("option", { name: "Common Stock" });
    choose(/^Record\*?$/, IDS.common);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain(`Link ${FILE} to share class Common Stock as Attachment.`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add link" }));
    expect(await screen.findByText(`${FILE} linked to Common Stock`)).toBeTruthy();
    expect(callsTo(api.routes.addDocumentLink).map((call) => call.body)).toEqual([{ role: "ATTACHMENT", target: { type: "stock_class", id: IDS.common } }]);
  }, 60_000);

  it("links to a transaction a command recorded, picked through its security", async () => {
    const timeline = securityHandlers.find((handler) => handler.route === api.routes.getSecurityTimeline)!;
    const add = mock(api.routes.addDocumentLink, () => ({ ...doc(), links: [link(1), link(8, { role: "CONSENT", targetType: "transaction", targetId: uuid(19, 1) })] }));
    const { callsTo } = documentPage(doc(), [add, timeline]);
    await action("Link to a record");
    const dialog = await screen.findByRole("dialog", { name: "Link to a record" });
    choose("Record type", "transaction");
    await within(dialog).findByRole("option", { name: "OPT-1 · Daniel Achterberg" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Security\*?$/)).toBe("Choose the record to link.");
    choose(/^Security\*?$/, IDS.opt1);
    await within(dialog).findByRole("option", { name: "Apr 14, 2023 · Issued — 300,000" });
    choose(/^Transaction\*?$/, uuid(19, 1));
    choose("Role", "CONSENT");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain(`Link ${FILE} to the transaction Apr 14, 2023 · Issued — 300,000 as Consent.`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add link" }));
    expect(await screen.findByText(`${FILE} linked to Apr 14, 2023 · Issued — 300,000`)).toBeTruthy();
    expect(callsTo(api.routes.addDocumentLink)[0]!.body).toEqual({ role: "CONSENT", target: { type: "transaction", id: uuid(19, 1) } });
  }, 60_000);

  it("puts the server's MULTIPLE_HOLDERS on the record field", async () => {
    const add = mock(api.routes.addDocumentLink, () => refused([{ code: "MULTIPLE_HOLDERS", message: "A holder-visible document must resolve to exactly one holder" }]));
    documentPage(doc(), [add]);
    await action("Link to a record");
    const dialog = await screen.findByRole("dialog", { name: "Link to a record" });
    choose("Record type", "stakeholder");
    await within(dialog).findByRole("option", { name: "Freya Lindqvist" });
    choose(/^Record\*?$/, IDS.freya);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add link" }));
    await waitFor(() => expect(errorOf(/^Record\*?$/)).toBe("A holder-visible document must resolve to exactly one holder"));
  }, 60_000);

  it("revokes a link with a reason", async () => {
    const linked = doc({
      version: 2,
      links: [link(1), link(4, { role: "EVIDENCE", targetType: "stock_plan", targetId: IDS.plan, createdAt: UPLOADED + 5000 })],
    });
    const revoke = mock(api.routes.revokeDocumentLink, () => ({ ...linked, links: [linked.links[0]!, { ...linked.links[1]!, revokedAt: UPLOADED + 9000, revokeReason: "Linked to the wrong plan" }] }));
    const { callsTo } = documentPage(linked, [revoke]);
    const table = await screen.findByRole("table", { name: "Links" });
    await within(table).findByText("2023 Equity Incentive Plan");
    expect(within(table).getByRole("button", { name: /Revoke the link to OPT-1/ })).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: "Revoke the link to 2023 Equity Incentive Plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke the link" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Reason/)).toBe("A reason is required.");
    type(/^Reason/, "Linked to the wrong plan");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke link" }));
    expect(await screen.findByText("Link to 2023 Equity Incentive Plan revoked")).toBeTruthy();
    const call = callsTo(api.routes.revokeDocumentLink)[0]!;
    expect(call.params.linkId).toBe(uuid(25, 4));
    expect(call.body).toEqual({ reason: "Linked to the wrong plan" });
  }, 60_000);

  it("shows a document to its one holder, reading the version again after a stale answer", async () => {
    let answers = 0;
    const page = { held: null as ReturnType<typeof server> | null };
    const visibility = mock(api.routes.setHolderVisibility, (request: MockRequest) => {
      answers += 1;
      if (answers === 1) {
        page.held!.state.current = doc({ description: "Countersigned", version: 2 });
        return staleVersion();
      }
      return doc({ holderVisible: true, visibilityScope: "holder", version: 3 });
    });
    const { held, callsTo } = documentPage(doc(), [visibility]);
    page.held = held;
    fireEvent.click(await screen.findByRole("button", { name: "Show to Daniel Achterberg" }));
    const dialog = await screen.findByRole("dialog", { name: "Show in the holder's portal" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain(`Daniel Achterberg sees ${FILE} under Documents in their portal. No e-mail is sent.`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Show to holder" }));
    expect(await within(dialog).findByText("It changed since you loaded it; reload it")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Show to holder" }));
    expect(await screen.findByText(`${FILE} is visible to Daniel Achterberg`)).toBeTruthy();
    expect(callsTo(api.routes.setHolderVisibility).map((call) => call.body)).toEqual([{ version: 1, visible: true }, { version: 2, visible: true }]);
  }, 60_000);

  it("never offers visibility on a document linked to two holders", async () => {
    documentPage(doc({ links: [link(1), link(5, { role: "ATTACHMENT", targetType: "stakeholder", targetId: IDS.freya })] }));
    expect(await screen.findByText(/Linked to 2 holders: a document linked to two or more holders is never shown in the portal/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Show to/ })).toBeNull();
  });

  it("sends company resources to the portal settings", async () => {
    const companyDoc = doc({ kind: "PLAN_DOCUMENT", filename: "2023 Equity Incentive Plan.pdf", links: [link(6, { role: "REPORT", targetType: "stock_plan", targetId: IDS.plan })] });
    documentPage(companyDoc, [], { role: "owner" });
    expect((await screen.findByRole("link", { name: "Stakeholder portal settings" })).getAttribute("href")).toBe(`${base}/stakeholder-portal`);
    expect(screen.queryByRole("button", { name: /^Show to|Publish/ })).toBeNull();
  });

  it("points every admin to the portal settings for a document without links", async () => {
    documentPage(doc({ kind: "PLAN_DOCUMENT", filename: "2023 Equity Incentive Plan.pdf", links: [] }));
    expect((await screen.findByRole("link", { name: "Stakeholder portal settings" })).getAttribute("href")).toBe(`${base}/stakeholder-portal`);
  });

  it("archives with a warning when the portal settings use the document", async () => {
    const resource = doc({ kind: "TEMPLATE", filename: "Notice of exercise form.pdf", links: [], holderVisible: true, visibilityScope: "all_holders" });
    const archive = mock(api.routes.patchDocument, () => ({ ...resource, archivedAt: UPLOADED + 2000, version: 2 }));
    const { callsTo } = documentPage(resource, [archive], { orgOverrides: [{}, { portal: { howToExerciseText: null, noticeFormDocumentId: resource.id, privacyNoticeDocumentId: null } }] });
    await action("Archive");
    const dialog = await screen.findByRole("dialog", { name: "Archive the document" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain("The portal settings use it as the notice of exercise form.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("Notice of exercise form.pdf archived")).toBeTruthy();
    expect(callsTo(api.routes.patchDocument)[0]!.body).toEqual({ version: 1, archived: true });
  }, 60_000);

  it("uploads a new version and opens it", async () => {
    const version = mock(api.routes.uploadDocumentVersion, (request: MockRequest) => doc({ id: uuid(10, 60), filename: "OPT-1 Option Agreement (v2).pdf", supersedesDocumentId: request.params.id!, links: [] }));
    const { callsTo, router } = documentPage(doc(), [version]);
    await action("Upload new version");
    const dialog = await screen.findByRole("dialog", { name: "Upload a new version" });
    await attach(/^New version/, "OPT-1 Option Agreement (v2).pdf");
    expect(callsTo(api.routes.uploadDocumentVersion)[0]!.params.id).toBe(DOC_ID);
    expect(callsTo(api.routes.uploadDocumentVersion)[0]!.headers.get("x-document-kind")).toBe("GRANT_AGREEMENT");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open the new version" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/documents/${uuid(10, 60)}`));
  }, 60_000);

  it("offers no write on a document about the admin's own holdings", async () => {
    documentPage(doc(), [], { ownStakeholderId: IDS.daniel });
    expect(await screen.findByText("About your own holdings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Show to/ })).toBeNull();
  });

  it("gives read-only admins no write", async () => {
    documentPage(doc(), [], { role: "admin_ro" });
    await screen.findByRole("heading", { name: FILE, level: 1 });
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Show to|Revoke/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});

describe("uploading for a record", () => {
  it("reports a stored upload when the dialog is closed instead of Done", async () => {
    renderPage(`securities/${IDS.opt1}`, [...securityHandlers, uploads()], { role: "admin_rw" });
    await action("Upload document");
    const dialog = await screen.findByRole("dialog", { name: "Upload a document for OPT-1" });
    await attach(/^File/, FILE);
    // Recorded: only Done in the footer, and the ✕ reports it too.
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(await screen.findByText((text) => text.startsWith(`${FILE} uploaded and linked to OPT-1`))).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Upload a document for OPT-1" })).toBeNull());
  }, 60_000);

  it("sends the link to the record with the upload, in one request with one key across a lost answer", async () => {
    let attempts = 0;
    const stored = (request: MockRequest) => doc({
      id: uuid(40, 1), filename: decodeURIComponent(request.headers.get("x-filename")!), kind: request.headers.get("x-document-kind") as api.DocumentKind,
      holderVisible: true, visibilityScope: "holder", links: [link(7, { role: request.headers.get("x-link-role") as api.DocumentLinkRole })],
    });
    const upload = mock(api.routes.uploadDocument, (request: MockRequest) => (++attempts === 1 ? unavailable() : stored(request)));
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, [...securityHandlers, upload], { role: "admin_rw" });
    await action("Upload document");
    const dialog = await screen.findByRole("dialog", { name: "Upload a document for OPT-1" });
    expect((within(dialog).getByLabelText("Type") as HTMLSelectElement).value).toBe("GRANT_AGREEMENT");
    stage(/^File/, FILE);
    const review = await within(dialog).findByLabelText(`Upload of ${FILE}`);
    await waitFor(() => expect(review.textContent).toContain("as Grant agreement, linked to OPT-1."));
    fireEvent.click(within(dialog).getByRole("button", { name: `Upload ${FILE}` }));
    expect(await within(dialog).findByText(LOST)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByRole("button", { name: `Remove ${FILE}` });
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    // The server linked it and applied the holder's default visibility in the same request.
    expect(await screen.findByText(`${FILE} uploaded and linked to OPT-1 — visible to Daniel Achterberg`)).toBeTruthy();
    const calls = callsTo(api.routes.uploadDocument);
    expect(calls).toHaveLength(2);
    expect(keysOf(calls)[0]).toBe(keysOf(calls)[1]);
    for (const call of calls) {
      expect(call.headers.get("x-link-target")).toBe("security");
      expect(call.headers.get("x-link-id")).toBe(IDS.opt1);
      expect(call.headers.get("x-link-role")).toBe("AGREEMENT");
      expect(call.headers.get("x-document-kind")).toBe("GRANT_AGREEMENT");
    }
  }, 60_000);
});
