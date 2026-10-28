import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, org, uuid } from "./support/acme.ts";
import { attach, choose, errorOf, keysOf, refused, staleVersion, type, unavailable, uploads } from "./support/flows.ts";
import { mock, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { renderPage } from "./support/render.tsx";

// Stakeholder Portal settings: owners and admins edit, editors view. Company resources
// (no holder link) are published here only; the notice of exercise form and the privacy notice are picked among the
// published ones; and every portal-section write sends all three keys over what is stored now.

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const AT = Date.UTC(2026, 9, 1, 17);

function doc(n: number, filename: string, overrides: Partial<api.Document> = {}): api.Document {
  return api.documentSchema.parse({
    id: uuid(10, n), filename, contentType: "application/pdf", byteSize: 98_304, sha256: "cd".repeat(32), kind: "OTHER", source: "upload",
    holderVisible: false, visibilityScope: "admins", collectionId: null, versionLabel: null, supersedesDocumentId: null, description: null, sourceCreatedAt: null,
    uploadedBy: "Rachel Ostrowski", createdAt: AT + n, archivedAt: null, links: [], importedFromPulley: false, version: 1,
    ...overrides,
  });
}

const FAQ = doc(70, "Exercise FAQ 2026.pdf", { holderVisible: true, visibilityScope: "all_holders" });
const PRIVACY = doc(71, "Privacy notice.pdf", { holderVisible: true, visibilityScope: "all_holders" });
const PLAN = doc(72, "2023 Equity Incentive Plan.pdf", { kind: "PLAN_DOCUMENT" });
const AGREEMENT = doc(73, "OPT-1 Option Agreement.pdf", { kind: "GRANT_AGREEMENT", holderVisible: true, visibilityScope: "holder", links: [{ id: uuid(25, 1), role: "AGREEMENT", targetType: "security", targetId: IDS.opt1, createdAt: AT, createdBy: null, revokedAt: null, revokeReason: null }] });
const DOCUMENTS = [FAQ, PRIVACY, PLAN, AGREEMENT];

const PORTAL = { howToExerciseText: "Send the notice of exercise to the equity team, then pay as shown below.", noticeFormDocumentId: null, privacyNoticeDocumentId: PRIVACY.id };

/** The org as the server holds it now (getOrg answers it). */
function orgState(initial: api.Org) {
  const state = { current: initial };
  return { state, response: () => json(state.current) };
}

function page(documents: () => api.Document[], extra: MockHandler[] = [], options: Parameters<typeof renderPage>[2] = {}) {
  return renderPage("stakeholder-portal", [mock(api.routes.listDocuments, () => ({ items: documents(), nextCursor: null })), ...extra], {
    orgOverrides: [{}, { portal: PORTAL }],
    ...options,
  });
}

describe("Stakeholder Portal settings: view", () => {
  it("shows the contact, the company resources, the picked notices and the How to exercise text", async () => {
    page(() => DOCUMENTS);
    expect(await screen.findByRole("heading", { name: "Stakeholder Portal", level: 1 })).toBeTruthy();
    expect(await screen.findByText("equity@acmerobotics.example")).toBeTruthy();
    const resources = await screen.findByRole("list", { name: "Company resources" });
    expect(within(resources).getAllByRole("listitem").map((item) => within(item).getAllByRole("link")[0]!.textContent)).toEqual(["Exercise FAQ 2026.pdf", "Privacy notice.pdf"]);
    expect(within(resources).getByText("The privacy notice")).toBeTruthy();
    expect(screen.getByText("Not chosen")).toBeTruthy();
    expect(screen.getByText(PORTAL.howToExerciseText)).toBeTruthy();
    expect(screen.getByText(/Their own holdings only/)).toBeTruthy();
  });

  it("is view only for an editor", async () => {
    page(() => DOCUMENTS, [], { role: "admin_ro", orgOverrides: [{}, { portal: PORTAL }] });
    await screen.findByRole("list", { name: "Company resources" });
    expect(screen.getByText(/View only — owners and admins edit/)).toBeTruthy();
    for (const name of [/^Edit/, /^Upload/, "Publish a document", /^Stop showing/]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("lets every admin edit, not only the owner", async () => {
    page(() => DOCUMENTS, [], { role: "admin_rw", orgOverrides: [{}, { portal: PORTAL }] });
    await screen.findByRole("list", { name: "Company resources" });
    expect(screen.getByText(/Owners and admins edit; editors view/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish a document" })).toBeTruthy();
  });
});

describe("Stakeholder Portal settings: company resources", () => {
  it("publishes a document with no holder link, and offers none that has one", async () => {
    const publish = mock(api.routes.setHolderVisibility, (request: MockRequest) => ({ ...PLAN, holderVisible: true, visibilityScope: "all_holders", version: 2 }));
    const { callsTo } = page(() => DOCUMENTS, [publish]);
    fireEvent.click(await screen.findByRole("button", { name: "Publish a document" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish a company resource" });
    const options = within(within(dialog).getByLabelText(/^Document/)).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["Choose…", "2023 Equity Incentive Plan.pdf"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Document/)).toBe("Choose the document to publish.");
    choose(/^Document/, PLAN.id);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain("Every holder sees 2023 Equity Incentive Plan.pdf under Company resources in their portal.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("2023 Equity Incentive Plan.pdf published — every holder sees it")).toBeTruthy();
    const call = callsTo(api.routes.setHolderVisibility)[0]!;
    expect(call.params.id).toBe(PLAN.id);
    expect(call.body).toEqual({ version: 1, visible: true });
  }, 60_000);

  it("stops showing a resource, saying when the portal settings use it", async () => {
    const hide = mock(api.routes.setHolderVisibility, () => ({ ...PRIVACY, holderVisible: false, visibilityScope: "admins", version: 2 }));
    const { callsTo } = page(() => DOCUMENTS, [hide]);
    fireEvent.click(await screen.findByRole("button", { name: "Stop showing Privacy notice.pdf to holders" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop showing to holders" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain("The portal settings use it as the privacy notice.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop showing" }));
    expect(await screen.findByText("Privacy notice.pdf is no longer shown to holders")).toBeTruthy();
    expect(callsTo(api.routes.setHolderVisibility)[0]!.body).toEqual({ version: 1, visible: false });
  }, 60_000);

  it("uploads a company resource and publishes it next", async () => {
    let stored: api.Document | null = null;
    const upload = uploads();
    const recorded = mock(api.routes.uploadDocument, async (request: MockRequest) => {
      stored = api.documentSchema.parse(await (upload.respond as (request: MockRequest) => unknown)(request));
      return stored;
    });
    const publish = mock(api.routes.setHolderVisibility, (request: MockRequest) => ({ ...stored!, holderVisible: true, visibilityScope: "all_holders", version: 2 }));
    const { callsTo } = page(() => (stored ? [...DOCUMENTS, stored] : DOCUMENTS), [recorded, publish]);
    fireEvent.click(await screen.findByRole("button", { name: "Upload a company resource" }));
    const dialog = await screen.findByRole("dialog", { name: "Upload a company resource" });
    await attach(/^File/, "Exercise FAQ 2027.pdf");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    const publishing = await screen.findByRole("dialog", { name: "Publish a company resource" });
    await waitFor(() => expect((within(publishing).getByLabelText(/^Document/) as HTMLSelectElement).value).toBe(uuid(40, 1)));
    fireEvent.click(within(publishing).getByRole("button", { name: "Review" }));
    fireEvent.click(within(publishing).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Exercise FAQ 2027.pdf published — every holder sees it")).toBeTruthy();
    expect(callsTo(api.routes.setHolderVisibility)[0]!.params.id).toBe(uuid(40, 1));
  }, 60_000);
});

describe("Stakeholder Portal settings: the portal section", () => {
  it("picks counsel's notice form among the published resources and sends all three keys", async () => {
    const server = orgState(org({}, { portal: PORTAL }));
    let answers = 0;
    const patch = mock(api.routes.patchOrg, (request: MockRequest) => {
      answers += 1;
      if (answers === 1) return unavailable();
      server.state.current = org({ version: 4 }, { portal: { ...PORTAL, noticeFormDocumentId: FAQ.id } });
      return server.state.current;
    });
    const { callsTo } = page(() => DOCUMENTS, [patch], { orgResponse: server.response });
    fireEvent.click(await screen.findByRole("button", { name: "Edit the portal documents" }));
    const dialog = await screen.findByRole("dialog", { name: "Portal documents" });
    const notice = within(dialog).getByLabelText(/^Notice of exercise form/);
    await waitFor(() => expect(within(notice).getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "Exercise FAQ 2026.pdf", "Privacy notice.pdf"]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Notice of exercise form/)).toBe("Nothing has changed.");
    choose(/^Notice of exercise form/, FAQ.id);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain("Notice of exercise form: Exercise FAQ 2026.pdf. Privacy notice: Privacy notice.pdf.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Portal documents saved")).toBeTruthy();
    const calls = callsTo(api.routes.patchOrg);
    const expected = { version: 3, settings: { portal: { howToExerciseText: PORTAL.howToExerciseText, noticeFormDocumentId: FAQ.id, privacyNoticeDocumentId: PRIVACY.id } } };
    expect(calls.map((call) => call.body)).toEqual([expected, expected]);
    expect(keysOf(calls)[0]).toBe(keysOf(calls)[1]);
  }, 60_000);

  it("puts PORTAL_DOCUMENT_NOT_COMPANY_RESOURCE on the picker that changed", async () => {
    const patch = mock(api.routes.patchOrg, () => refused([{ code: "PORTAL_DOCUMENT_NOT_COMPANY_RESOURCE", message: "Choose an unarchived, holder-visible company resource with no holder link" }]));
    page(() => DOCUMENTS, [patch]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit the portal documents" }));
    const dialog = await screen.findByRole("dialog", { name: "Portal documents" });
    await within(dialog).findAllByRole("option", { name: "Exercise FAQ 2026.pdf" });
    choose(/^Notice of exercise form/, FAQ.id);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(errorOf(/^Notice of exercise form/)).toBe("Choose an unarchived, holder-visible company resource with no holder link"));
  }, 60_000);

  it("rebuilds the section from the org read again after a stale answer, keeping another admin's change", async () => {
    const server = orgState(org({}, { portal: PORTAL }));
    let answers = 0;
    const patch = mock(api.routes.patchOrg, (request: MockRequest) => {
      answers += 1;
      if (answers === 1) {
        // Another admin saved a new How to exercise text meanwhile.
        server.state.current = org({ version: 4 }, { portal: { ...PORTAL, howToExerciseText: "Updated by the equity team." } });
        return staleVersion();
      }
      return org({ version: 5 }, { portal: { howToExerciseText: "Updated by the equity team.", noticeFormDocumentId: FAQ.id, privacyNoticeDocumentId: PRIVACY.id } });
    });
    const { callsTo } = page(() => DOCUMENTS, [patch], { orgResponse: server.response });
    fireEvent.click(await screen.findByRole("button", { name: "Edit the portal documents" }));
    const dialog = await screen.findByRole("dialog", { name: "Portal documents" });
    await within(dialog).findAllByRole("option", { name: "Exercise FAQ 2026.pdf" });
    choose(/^Notice of exercise form/, FAQ.id);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("It changed since you loaded it; reload it")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Portal documents saved")).toBeTruthy();
    expect(callsTo(api.routes.patchOrg)[1]!.body).toEqual({ version: 4, settings: { portal: { howToExerciseText: "Updated by the equity team.", noticeFormDocumentId: FAQ.id, privacyNoticeDocumentId: PRIVACY.id } } });
  }, 60_000);

  it("saves the How to exercise text with the stored picks", async () => {
    const patch = mock(api.routes.patchOrg, () => org({ version: 4 }, { portal: { ...PORTAL, howToExerciseText: "Exercise through the equity team." } }));
    const { callsTo } = page(() => DOCUMENTS, [patch]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit the How to exercise text" }));
    const dialog = await screen.findByRole("dialog", { name: "How to exercise — text" });
    type(/^Text holders see on How to exercise/, "Exercise through the equity team.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Save text" }));
    expect(await screen.findByText("How to exercise text saved")).toBeTruthy();
    expect(callsTo(api.routes.patchOrg)[0]!.body).toEqual({ version: 3, settings: { portal: { howToExerciseText: "Exercise through the equity team.", noticeFormDocumentId: null, privacyNoticeDocumentId: PRIVACY.id } } });
  }, 60_000);

  it("names a picked document that is no longer a company resource, and sends nothing the server would refuse", async () => {
    const archived = { ...PRIVACY, archivedAt: AT + 500 };
    const { callsTo } = page(() => [FAQ, archived, PLAN, AGREEMENT]);
    expect(await screen.findByText("A portal document is no longer a published company resource")).toBeTruthy();
    expect(screen.getByText("No longer a published company resource")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit the How to exercise text" }));
    const dialog = await screen.findByRole("dialog", { name: "How to exercise — text" });
    type(/^Text holders see on How to exercise/, "Exercise through the equity team.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Text holders see on How to exercise/)).toContain("the privacy notice, which is no longer a published company resource");
    expect(callsTo(api.routes.patchOrg)).toHaveLength(0);
  });
});
