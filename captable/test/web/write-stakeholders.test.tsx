import "./setup.ts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, ORG_ID, STAKEHOLDERS, stakeholder, stakeholderList, uuid } from "./support/acme.ts";
import { DIFF_A, LOST, attach, choose, commandRoute, dryRuns, errorOf, expectSentAsPreviewed, field, keysOf, realCalls, refused, result, staleVersion, toAcknowledge, type, unavailable, uploads } from "./support/flows.ts";
import { apiError, mock, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { ECHO, STAKEHOLDER_DETAILS } from "./support/securities.ts";
import { base, renderPage } from "./support/render.tsx";

// Stakeholders: add and edit a record with its e-mail, add and remove e-mails, and merge two records.
// These routes have no dry run: each reviews its change, then records it with one key per
// intent; a PATCH sends the version it read and reloads it after a stale answer.

const THEO = uuid(3, 41);
const emailOf = (id: number, address: string): api.StakeholderEmail => ({ ...STAKEHOLDERS.nadia.emails[0]!, id: uuid(11, id), email: address, addedBy: "Morgan Ellis" });
const theo = stakeholder({
  id: THEO, displayName: "Theo Marchetti", hireDate: "2026-10-19", provenance: { importedFromPulley: false, pulleyId: null },
  emails: [emailOf(902, "theo.marchetti@mailbox.example")],
});

function pageHandlers(...extra: MockHandler[]): MockHandler[] {
  const routes = new Set(extra.map((handler) => handler.route));
  return [
    mock(api.routes.getStakeholder, (request: MockRequest) => STAKEHOLDER_DETAILS[request.params.id!] ?? apiError(404, "not_found", "Not found")),
    mock(api.routes.getStakeholderHoldings, { ...ECHO, items: [] }),
    mock(api.routes.listVestingTerms, { items: [] }),
    mock(api.routes.listDocuments, { items: [], nextCursor: null }),
    mock(api.routes.listOrgAudit, { items: [], nextCursor: null }),
    mock(api.routes.listStakeholders, stakeholderList()),
    uploads(),
  ].filter((handler) => !routes.has(handler.route)).concat(extra);
}

async function fillTheo() {
  await screen.findByRole("heading", { name: "Add stakeholder", level: 1 });
  type(/Legal name/, "Theo Marchetti");
  type(/^E-mail/, "theo.marchetti@mailbox.example");
  type("Hire date", "2026-10-19");
}

describe("add stakeholder", () => {
  it("checks the name, the e-mail and a partial address before anything is sent", async () => {
    const create = commandRoute(api.routes.createStakeholder, { commit: theo });
    const { callsTo } = renderPage("stakeholders/new", pageHandlers(create), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Add stakeholder", level: 1 });
    type(/^E-mail/, "not-an-address");
    type("Postal code", "94607");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(errorOf(/Legal name/)).toBe("Legal name is required.");
    expect(errorOf(/^E-mail/)).toBe("Enter a valid e-mail address.");
    expect(errorOf("City")).toBe("Enter the city.");
    expect(errorOf("Country")).toBe("Use a two-letter country code, e.g. US.");
    expect(callsTo(api.routes.createStakeholder)).toHaveLength(0);
  }, 60_000);

  it("warns about a duplicate e-mail, reviews the new record exactly and adds it with a key", async () => {
    const create = commandRoute(api.routes.createStakeholder, { commit: theo });
    const { callsTo, router } = renderPage("stakeholders/new", pageHandlers(create), { role: "admin_rw" });
    await fillTheo();
    type(/^E-mail/, "daniel.achterberg@mailbox.example");
    expect(await screen.findByText("Daniel Achterberg already uses this e-mail. You can still save; duplicate records can be merged from the stakeholder page.")).toBeTruthy();
    type(/^E-mail/, "theo.marchetti@mailbox.example");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByLabelText("Review").textContent).toBe("Review the new stakeholderAdd Theo Marchetti (Individual · Employee) with e-mail theo.marchetti@mailbox.example.");
    fireEvent.click(screen.getByRole("button", { name: "Add stakeholder" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${THEO}`));
    const call = callsTo(api.routes.createStakeholder)[0]!;
    expect(call.body).toEqual({
      kind: "individual", displayName: "Theo Marchetti", legalName: "Theo Marchetti", relationship: "employee", hireDate: "2026-10-19",
      emails: [{ email: "theo.marchetti@mailbox.example", kind: "self" }],
      acknowledge: [],
    });
    expect(call.headers.get("Idempotency-Key")).toBeTruthy();
    expect(await screen.findByText("Theo Marchetti added")).toBeTruthy();
  }, 60_000);

  it("shows the server's issues on the e-mail, asks to acknowledge DUPLICATE_EMAIL and retries with the same key", async () => {
    const issue = apiError(400, "validation_failed", "Invalid", { issues: [{ path: "emails.0.email", message: "Enter an e-mail address" }] });
    const duplicate = toAcknowledge([{ code: "DUPLICATE_EMAIL", message: "Daniel Achterberg already uses this e-mail" }]);
    const create = commandRoute(api.routes.createStakeholder, { commit: [issue, duplicate, unavailable(), theo] });
    const { callsTo, router } = renderPage("stakeholders/new", pageHandlers(create), { role: "admin_rw" });
    await fillTheo();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Add stakeholder" }));
    await waitFor(() => expect(errorOf(/^E-mail/)).toBe("Enter an e-mail address"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Add stakeholder" }));
    const acknowledge = await screen.findByLabelText(/Daniel Achterberg already uses this e-mail/);
    const add = screen.getByRole("button", { name: "Add stakeholder" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(acknowledge);
    fireEvent.click(add);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${THEO}`));
    const calls = callsTo(api.routes.createStakeholder);
    expect(calls.map((call) => (call.body as { acknowledge: string[] }).acknowledge)).toEqual([[], [], ["DUPLICATE_EMAIL"], ["DUPLICATE_EMAIL"]]);
    // Each refused body leaves no receipt and the next gets its own key; the lost answer is retried with the same one.
    const keys = keysOf(calls);
    expect(keys[3]).toBe(keys[2]);
    expect(new Set(keys).size).toBe(3);
  }, 60_000);

  it("resolves a lost no-e-mail create through the same idempotency replay", async () => {
    const noEmail = { ...theo, emails: [] };
    const create = commandRoute(api.routes.createStakeholder, { commit: [unavailable(), noEmail] });
    const { callsTo, router } = renderPage("stakeholders/new", pageHandlers(create), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Add stakeholder", level: 1 });
    type(/Legal name/, "Theo Marchetti");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Add stakeholder" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check what was recorded" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${THEO}`));
    const calls = callsTo(api.routes.createStakeholder);
    expect(calls).toHaveLength(2);
    expect(keysOf(calls)[1]).toBe(keysOf(calls)[0]);
    expect((calls[1]!.body as { emails: unknown[] }).emails).toEqual([]);
  }, 60_000);

  it("is closed to read-only admins", async () => {
    renderPage("stakeholders/new", pageHandlers(), { role: "admin_ro" });
    expect(await screen.findByText("You have read-only access")).toBeTruthy();
  }, 60_000);
});

describe("edit stakeholder", () => {
  const renamed = { ...STAKEHOLDERS.daniel, displayName: "Dan Achterberg", version: 3 };

  it("sends only what changed with the version read, shows the server's issue on its field, and reloads the version after a stale answer", async () => {
    let reads = 0;
    const issue = apiError(400, "validation_failed", "Invalid", { issues: [{ path: "displayName", message: "At most 200 characters" }] });
    const patch = commandRoute(api.routes.patchStakeholder, { commit: [issue, staleVersion(), renamed] });
    const getStakeholder = mock(api.routes.getStakeholder, (request: MockRequest) => ({ ...STAKEHOLDER_DETAILS[request.params.id!]!, version: ++reads === 1 ? 1 : 2 }));
    const { callsTo, router } = renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(getStakeholder, patch), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Edit Daniel Achterberg", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(errorOf(/Legal name/)).toBe("Nothing has changed.");
    type("Display name", "Dan Achterberg");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(within(screen.getByLabelText("Changes")).getByText("Display name").parentElement!.textContent).toBe("Display nameDaniel Achterberg→Dan Achterberg");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(errorOf("Display name")).toBe("At most 200 characters"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Review again")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${IDS.daniel}`));
    const calls = callsTo(api.routes.patchStakeholder);
    expect(calls.map((call) => call.body)).toEqual([{ version: 1, displayName: "Dan Achterberg" }, { version: 1, displayName: "Dan Achterberg" }, { version: 2, displayName: "Dan Achterberg" }]);
    expect(new Set(keysOf(calls)).size).toBe(3);
  }, 60_000);

  it("after a stale answer, keeps someone else's change to a field it didn't touch, shows what changed, and asks again", async () => {
    let reads = 0;
    const original = STAKEHOLDER_DETAILS[IDS.daniel]!;
    // Meanwhile someone else changed the phone (not edited here) and the comments (edited here too).
    const concurrent = { ...original, phone: "+1 510 555 0199", comments: "Moved to the Oakland office", version: 2 };
    const getStakeholder = mock(api.routes.getStakeholder, () => (++reads === 1 ? original : concurrent));
    const saved = { ...STAKEHOLDERS.daniel, displayName: "Dan Achterberg", phone: "+1 510 555 0199", comments: "Prefers e-mail", version: 3 };
    const patch = commandRoute(api.routes.patchStakeholder, { commit: [staleVersion(), saved] });
    const { callsTo, router } = renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(getStakeholder, patch), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Edit Daniel Achterberg", level: 1 });
    type("Display name", "Dan Achterberg");
    type("Comments", "Prefers e-mail");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Review again")).toBeTruthy();
    const changed = screen.getByLabelText("Changed on the server");
    expect(changed.textContent).toContain("Phone+1 510 555 0100→+1 510 555 0199");
    expect(changed.textContent).toContain("Comments—→Moved to the Oakland office · you edited this too: your value replaces it if you save");
    expect(field("Phone").value).toBe("+1 510 555 0199");
    expect(within(screen.getByLabelText("Changes")).queryByText("Phone")).toBeNull();
    // Nothing is sent until the new review is confirmed.
    expect(callsTo(api.routes.patchStakeholder)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${IDS.daniel}`));
    const calls = callsTo(api.routes.patchStakeholder);
    expect(calls.map((call) => call.body)).toEqual([
      { version: 1, displayName: "Dan Achterberg", comments: "Prefers e-mail" },
      { version: 2, displayName: "Dan Achterberg", comments: "Prefers e-mail" },
    ]);
  }, 60_000);

  it("clears an emptied optional field and the whole address: null is sent, and the review says Cleared", async () => {
    const patch = commandRoute(api.routes.patchStakeholder, { commit: { ...STAKEHOLDERS.daniel, phone: null, hireDate: null, address: null, version: 2 } });
    const { callsTo, router } = renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(patch), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Edit Daniel Achterberg", level: 1 });
    type("Phone", "");
    type("Hire date", "");
    for (const label of ["Address", "City", "State or region", "Postal code", "Country"]) type(new RegExp(`^${label}$`), "");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const changes = screen.getByLabelText("Changes");
    expect(within(changes).getByText("Phone").parentElement!.textContent).toBe("Phone+1 510 555 0100→Cleared");
    expect(within(changes).getByText("Hire date").parentElement!.textContent).toBe("Hire date2023-03-01→Cleared");
    expect(within(changes).getByText("Address").parentElement!.textContent).toBe("Address120 Larkspur Ln, Oakland, CA 94610, US→Cleared");
    expect(within(changes).queryByText("City")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${IDS.daniel}`));
    expect(callsTo(api.routes.patchStakeholder)[0]!.body).toEqual({ version: 1, phone: null, hireDate: null, address: null });
  }, 60_000);

  it("after a lost answer, freezes the edit until the check finds nothing recorded; a changed edit then gets its own key", async () => {
    const patch = commandRoute(api.routes.patchStakeholder, { commit: [unavailable(), { ...STAKEHOLDERS.daniel, displayName: "Danny Achterberg", version: 2 }] });
    const { callsTo, router } = renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(patch), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Edit Daniel Achterberg", level: 1 });
    type("Display name", "Dan Achterberg");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    const back = screen.getByRole("button", { name: "Back to edit" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    // The record still has the version the PATCH sent: nothing was written.
    fireEvent.click(screen.getByRole("button", { name: "Check what was recorded" }));
    expect(await screen.findByText(/^The server has no record of it/)).toBeTruthy();
    await waitFor(() => expect(back.disabled).toBe(false));
    fireEvent.click(back);
    type("Display name", "Danny Achterberg");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${IDS.daniel}`));
    const calls = callsTo(api.routes.patchStakeholder);
    expect(calls.map((call) => call.body)).toEqual([{ version: 1, displayName: "Dan Achterberg" }, { version: 1, displayName: "Danny Achterberg" }]);
    expect(keysOf(calls)[1]).not.toBe(keysOf(calls)[0]);
  }, 60_000);

  it("keeps a termination's relationship and refuses the admin's own record", async () => {
    renderPage(`stakeholders/${IDS.nadia}/edit`, pageHandlers(), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Edit Nadia Pereira-Stone", level: 1 });
    expect((screen.getByLabelText("Relationship") as HTMLSelectElement).disabled).toBe(true);
    renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(), { role: "admin_rw", ownStakeholderId: IDS.daniel });
    expect(await screen.findByText("This is your own record")).toBeTruthy();
  }, 60_000);
});

describe("merge stakeholders", () => {
  const mergeView: NonNullable<api.CommandResult["stakeholderMerge"]> = {
    merged: { id: IDS.daniel, displayName: "Daniel Achterberg" },
    survivor: { id: IDS.freya, displayName: "Freya Lindqvist" },
    holdings: {
      survivorBefore: { securityCount: 2, issuedAndOutstanding: "4000000", fullyDiluted: "4300000", capitalContribution: "400" },
      mergedBefore: { securityCount: 2, issuedAndOutstanding: "50000", fullyDiluted: "300000", capitalContribution: "5000" },
      survivorAfter: { securityCount: 4, issuedAndOutstanding: "4050000", fullyDiluted: "4600000", capitalContribution: "5400" },
    },
    addresses: [
      { email: "daniel.achterberg@mailbox.example", action: "move" },
      { email: "shared@mailbox.example", action: "deduplicate" },
    ],
    profileDifferences: [{ field: "legalName", survivorValue: "Freya Lindqvist", mergedValue: "Daniel Achterberg" }],
    blockingItems: [],
    confirmation: "Daniel Achterberg",
  };

  it("shows the server preview, requires the typed name, commits exactly what was reviewed and opens the survivor", async () => {
    const preview = result({ stakeholderMerge: mergeView });
    const route = commandRoute(api.routes.mergeStakeholders, { preview, commit: result({ stakeholderMerge: mergeView }, true) });
    const { callsTo, router } = renderPage(`stakeholders/${IDS.daniel}`, pageHandlers(route), { role: "owner" });
    fireEvent.click(await screen.findByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Merge into another stakeholder…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge into another stakeholder" });
    choose(/Surviving record/, IDS.freya);
    type(/^Reason/, "The import created a duplicate record");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    const review = await within(dialog).findByLabelText("Merge preview");
    expect(within(review).getByRole("table", { name: "Holdings before and after merge" }).textContent).toContain("4,600,000");
    expect(review.textContent).toContain("daniel.achterberg@mailbox.example (move)");
    expect(review.textContent).toContain("legalName");
    const confirm = within(dialog).getByRole("button", { name: "Merge stakeholder" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type(/Type Daniel Achterberg to confirm/, "Daniel Achterberg");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${IDS.freya}`));
    const calls = callsTo(api.routes.mergeStakeholders);
    expect(dryRuns(calls)).toHaveLength(1);
    expect(realCalls(calls)).toHaveLength(1);
    expect(dryRuns(calls)[0]!.body).toEqual({ mergedStakeholderId: IDS.daniel, survivingStakeholderId: IDS.freya, reason: "The import created a duplicate record" });
    expect(realCalls(calls)[0]!.body).toEqual({
      mergedStakeholderId: IDS.daniel,
      survivingStakeholderId: IDS.freya,
      reason: "The import created a duplicate record",
      confirmation: "Daniel Achterberg",
      expectedLedgerSeq: 412,
      expectedDiffSha256: DIFF_A,
      acknowledge: [],
    });
    expect(realCalls(calls)[0]!.headers.get("Idempotency-Key")).toBeTruthy();
  }, 60_000);

  it("shows the merged-record destination and the records merged into a survivor", async () => {
    const commandId = uuid(30, 91);
    const merged = api.stakeholderDetailSchema.parse({
      ...STAKEHOLDER_DETAILS[IDS.daniel]!,
      mergedInto: { id: IDS.freya, displayName: "Freya Lindqvist", commandId },
    });
    renderPage(`stakeholders/${IDS.daniel}`, pageHandlers(mock(api.routes.getStakeholder, merged)), { role: "owner" });
    const destination = await screen.findByText("Freya Lindqvist");
    expect(destination.closest("a")?.getAttribute("href")).toBe(`${base}/stakeholders/${IDS.freya}`);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Undo stakeholder merge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add representative" })).toBeNull();
  }, 60_000);

  it("lists merged records on the survivor", async () => {
    const survivor = api.stakeholderDetailSchema.parse({
      ...STAKEHOLDER_DETAILS[IDS.freya]!,
      mergedRecords: [{ id: IDS.daniel, displayName: "Daniel Achterberg", commandId: uuid(30, 91) }],
    });
    renderPage(`stakeholders/${IDS.freya}`, pageHandlers(mock(api.routes.getStakeholder, survivor)), { role: "owner" });
    expect((await screen.findByText(/Merged into this record:/)).textContent).toContain("Daniel Achterberg");
  }, 60_000);

  it("shows server blockers and keeps commit disabled", async () => {
    const blockedView = { ...mergeView, blockingItems: [{ type: "exercise_request", id: uuid(33, 1), label: "Open exercise request (AWAITING_PAYMENT)" }] };
    const route = commandRoute(api.routes.mergeStakeholders, { preview: result({ stakeholderMerge: blockedView }) });
    renderPage(`stakeholders/${IDS.daniel}`, pageHandlers(route), { role: "owner" });
    fireEvent.click(await screen.findByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Merge into another stakeholder…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge into another stakeholder" });
    choose(/Surviving record/, IDS.freya);
    type(/^Reason/, "The import created a duplicate record");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(await within(dialog).findByText("Open exercise request (AWAITING_PAYMENT)")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Merge stakeholder" }) as HTMLButtonElement).disabled).toBe(true);
  }, 60_000);
});

describe("stakeholder e-mails", () => {
  /** Nadia's record as the server holds it: an add or a remove changes it, and the page reads it again. */
  function nadiaServer() {
    const state = { current: STAKEHOLDER_DETAILS[IDS.nadia]! };
    const getStakeholder = mock(api.routes.getStakeholder, (request: MockRequest) =>
      request.params.id === IDS.nadia ? state.current : STAKEHOLDER_DETAILS[request.params.id!] ?? apiError(404, "not_found", "Not found"));
    return { state, getStakeholder };
  }

  it("adds an address after review, keeps one key across a lost answer, and lists it", async () => {
    const server = nadiaServer();
    let answers = 0;
    const add = mock(api.routes.addStakeholderEmail, (request: MockRequest) => {
      answers += 1;
      const body = request.body as api.StakeholderEmailRequest;
      const added = { ...emailOf(950, body.email), kind: body.kind, createdAt: Date.UTC(2026, 9, 21, 17) };
      if (!server.state.current.emails.some((email) => email.email === body.email)) server.state.current = { ...server.state.current, emails: [...server.state.current.emails, added] };
      return answers === 1 ? unavailable() : added;
    });
    const { callsTo } = renderPage(`stakeholders/${IDS.nadia}`, pageHandlers(server.getStakeholder, add), { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: "Add an e-mail to Nadia Pereira-Stone" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an e-mail — Nadia Pereira-Stone" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^E-mail\W*$/)).toBe("Enter a valid e-mail address.");
    type(/^E-mail\W*$/, "NADIA.PS@mailbox.example");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^E-mail\W*$/)).toBe("This stakeholder already has this address.");
    type(/^E-mail\W*$/, "nadia.pereira@mailbox.example");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain("Add nadia.pereira@mailbox.example (own address) to Nadia Pereira-Stone.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add e-mail" }));
    expect(await within(dialog).findByText(LOST)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("nadia.pereira@mailbox.example added to Nadia Pereira-Stone")).toBeTruthy();
    const calls = callsTo(api.routes.addStakeholderEmail);
    expect(calls.map((call) => call.body)).toEqual([
      { email: "nadia.pereira@mailbox.example", kind: "self", acknowledge: [] },
      { email: "nadia.pereira@mailbox.example", kind: "self", acknowledge: [] },
    ]);
    expect(keysOf(calls)[1]).toBe(keysOf(calls)[0]);
    expect(calls[0]!.url.pathname).toBe(`/api/orgs/${ORG_ID}/stakeholders/${IDS.nadia}/emails`);
    const table = await screen.findByRole("table", { name: "E-mails" });
    await waitFor(() => expect(within(table).getByText("nadia.pereira@mailbox.example")).toBeTruthy());
  }, 60_000);

  it("asks a representative's name and authorizing document, and sends them", async () => {
    const add = mock(api.routes.addStakeholderEmail, (request: MockRequest) => {
      const body = request.body as api.StakeholderEmailRequest;
      return { ...emailOf(951, body.email), kind: body.kind, contactName: body.contactName ?? null, contactRole: body.contactRole ?? null, authorizingDocumentId: body.authorizingDocumentId ?? null };
    });
    const { callsTo } = renderPage(`stakeholders/${IDS.nadia}`, pageHandlers(add), { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: "Add an e-mail to Nadia Pereira-Stone" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an e-mail — Nadia Pereira-Stone" });
    type(/^E-mail\W*$/, "estate@counsel.example");
    choose("Whose address", "representative");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Representative's name/)).toBe("Enter the representative's name.");
    expect(within(dialog).getByText("A representative needs the authorizing document.")).toBeTruthy();
    type(/^Representative's name/, "Jordan Vale");
    type(/^Role/, "Executor");
    await attach(/^Authorizing document/, "Letters of administration.pdf");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain("(representative: Jordan Vale)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add e-mail" }));
    expect(await screen.findByText("estate@counsel.example added to Nadia Pereira-Stone")).toBeTruthy();
    expect(callsTo(api.routes.addStakeholderEmail)[0]!.body).toEqual({
      email: "estate@counsel.example", kind: "representative", contactName: "Jordan Vale", contactRole: "Executor", authorizingDocumentId: uuid(40, 1), acknowledge: [],
    });
  }, 60_000);

  it("asks to acknowledge an address another stakeholder uses, then sends the acknowledgement", async () => {
    let answers = 0;
    const add = mock(api.routes.addStakeholderEmail, (request: MockRequest) => {
      answers += 1;
      const body = request.body as api.AddStakeholderEmailRequest;
      if (answers === 1) return toAcknowledge([{ code: "DUPLICATE_EMAIL", message: "Daniel Achterberg already uses this e-mail" }]);
      return { ...emailOf(952, body.email), kind: body.kind };
    });
    const { callsTo } = renderPage(`stakeholders/${IDS.nadia}`, pageHandlers(add), { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: "Add an e-mail to Nadia Pereira-Stone" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an e-mail — Nadia Pereira-Stone" });
    type(/^E-mail\W*$/, "daniel.achterberg@mailbox.example");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add e-mail" }));
    const acknowledge = await within(dialog).findByLabelText(/Daniel Achterberg already uses this e-mail/);
    const confirm = within(dialog).getByRole("button", { name: "Add e-mail" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(acknowledge);
    fireEvent.click(confirm);
    expect(await screen.findByText("daniel.achterberg@mailbox.example added to Nadia Pereira-Stone")).toBeTruthy();
    const calls = callsTo(api.routes.addStakeholderEmail);
    expect(calls.map((call) => (call.body as { acknowledge: string[] }).acknowledge)).toEqual([[], ["DUPLICATE_EMAIL"]]);
    expect(keysOf(calls)[1]).not.toBe(keysOf(calls)[0]);
  }, 60_000);

  it("removes an address with an optional reason, after review", async () => {
    const server = nadiaServer();
    const remove = mock(api.routes.removeStakeholderEmail, (request: MockRequest) => {
      const removed = { ...server.state.current.emails.find((email) => email.id === request.params.emailId)!, removedAt: Date.UTC(2026, 9, 21, 17) };
      server.state.current = { ...server.state.current, emails: server.state.current.emails.map((email) => (email.id === removed.id ? removed : email)) };
      return removed;
    });
    const { callsTo } = renderPage(`stakeholders/${IDS.nadia}`, pageHandlers(server.getStakeholder, remove), { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: "Remove nadia.ps@mailbox.example" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the e-mail" });
    type(/^Reason/, "The holder changed address");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByLabelText("Review").textContent).toContain("A console user with this e-mail no longer sees these holdings.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove e-mail" }));
    expect(await screen.findByText("nadia.ps@mailbox.example removed from Nadia Pereira-Stone")).toBeTruthy();
    const [call] = callsTo(api.routes.removeStakeholderEmail);
    expect(call!.url.pathname).toBe(`/api/orgs/${ORG_ID}/stakeholders/${IDS.nadia}/emails/${STAKEHOLDERS.nadia.emails[0]!.id}/remove`);
    expect(call!.body).toEqual({ reason: "The holder changed address" });
    expect(call!.headers.get("Idempotency-Key")).toBeTruthy();
    expect(await screen.findByText("No e-mail address yet. Without one, this stakeholder can't see their holdings in the holder view.")).toBeTruthy();
  }, 60_000);

  it("offers no e-mail writes to an editor or on the admin's own record", async () => {
    renderPage(`stakeholders/${IDS.nadia}`, pageHandlers(), { role: "admin_ro" });
    await screen.findByRole("table", { name: "E-mails" });
    expect(screen.queryByRole("button", { name: /^Add an e-mail|^Remove / })).toBeNull();
    cleanup();
    renderPage(`stakeholders/${IDS.nadia}`, pageHandlers(), { role: "admin_rw", ownStakeholderId: IDS.nadia });
    await screen.findByRole("table", { name: "E-mails" });
    expect(screen.queryByRole("button", { name: /^Add an e-mail|^Remove / })).toBeNull();
  }, 60_000);
});

describe("leave of absence", () => {
  const leavePreview = result({
    transactions: [{ id: null, seq: null, type: "X_STAKEHOLDER_LEAVE", effectiveDate: "2026-06-01", securityId: null, quantity: null }],
    changes: [{ entity: "stakeholder", id: IDS.daniel, before: { leaves: [] }, after: { leaves: [{ startDate: "2026-06-01", endDate: "2026-10-01", returnGuaranteed: false }] } }],
  });

  it("records a leave after the server's preview, with its checks and the server's refusal on the field it names", async () => {
    const leave = commandRoute(api.routes.recordLeaveOfAbsence, {
      preview: [refused([{ code: "LEAVE_DATES", message: "A leave can't end before it starts" }]), leavePreview],
      commit: result({ ...leavePreview, commandId: uuid(30, 8), dryRun: false }, true),
    });
    const { callsTo } = renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(leave), { role: "admin_rw" });
    const section = await screen.findByLabelText("Record a leave of absence");
    expect(screen.getByText("No leave of absence recorded.")).toBeTruthy();
    type(/^Leave start/, "2026-12-01");
    fireEvent.click(within(section).getByRole("button", { name: "Review leave" }));
    expect(errorOf(/^Leave start/)).toBe("Record a leave once it has started.");
    type(/^Leave start/, "2026-06-01");
    type("Leave end", "2026-05-01");
    fireEvent.click(within(section).getByRole("button", { name: "Review leave" }));
    expect(errorOf("Leave end")).toBe("The leave can't end before it starts.");
    expect(callsTo(api.routes.recordLeaveOfAbsence)).toHaveLength(0);
    type("Leave end", "2026-10-01");
    fireEvent.click(within(section).getByRole("button", { name: "Review leave" }));
    await waitFor(() => expect(errorOf("Leave end")).toBe("A leave can't end before it starts"));
    fireEvent.click(within(section).getByRole("button", { name: "Review leave" }));
    const panel = await within(section).findByRole("region", { name: "Server preview" });
    expect(within(panel).getByRole("region", { name: "Daniel Achterberg" }).textContent).toContain("Leave of absenceNone→Jun 1, 2026 → Oct 1, 2026");
    fireEvent.click(within(section).getByRole("button", { name: "Record leave" }));
    expect(await screen.findByText("Leave of absence recorded — Daniel Achterberg")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.recordLeaveOfAbsence))[0]!;
    expect(real.body).toEqual({ stakeholderId: IDS.daniel, startDate: "2026-06-01", endDate: "2026-10-01", returnGuaranteed: false, expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A, acknowledge: [] });
    expectSentAsPreviewed(dryRuns(callsTo(api.routes.recordLeaveOfAbsence))[1]!, real);
    expect(real.headers.get("Idempotency-Key")).toBeTruthy();
  }, 60_000);

  it("ends an open leave by its start date, and points a new overlapping leave to it", async () => {
    const open = { startDate: "2026-06-01", endDate: null, returnGuaranteed: false };
    const onLeave = api.stakeholderDetailSchema.parse({ ...STAKEHOLDER_DETAILS[IDS.daniel]!, leaveOfAbsence: [open] });
    const ended = result({
      transactions: [{ id: null, seq: null, type: "X_STAKEHOLDER_LEAVE", effectiveDate: "2026-06-01", securityId: null, quantity: null }],
      changes: [{ entity: "stakeholder", id: IDS.daniel, before: { leaves: [open] }, after: { leaves: [{ ...open, endDate: "2026-08-15", returnGuaranteed: true }] } }],
    });
    const leave = commandRoute(api.routes.recordLeaveOfAbsence, {
      preview: [refused([{ code: "LEAVE_OVERLAPS", message: "The leave that started on 2026-06-01 is still open: to record its end, send its start date" }]), ended],
      commit: result({ ...ended, commandId: uuid(30, 8), dryRun: false }, true),
    });
    const { callsTo } = renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(mock(api.routes.getStakeholder, onLeave), leave), { role: "admin_rw" });
    const section = await screen.findByLabelText("Record a leave of absence");
    // A new leave inside the open one is pointed to that leave before anything is sent.
    type(/^Leave start/, "2026-07-01");
    fireEvent.click(within(section).getByRole("button", { name: "Review leave" }));
    expect(errorOf(/^Leave start/)).toBe("The leave that started on Jun 1, 2026 is still open: record its end first (\"Record its end\" above).");
    expect(callsTo(api.routes.recordLeaveOfAbsence)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /^Record its end/ }));
    const closing = await screen.findByLabelText("Record a leave of absence");
    expect(field(/^Leave start/).value).toBe("2026-06-01");
    expect(field(/^Leave start/).disabled).toBe(true);
    fireEvent.click(within(closing).getByRole("button", { name: "Review leave" }));
    expect(errorOf(/^Leave end/)).toBe("Enter the date the leave ended.");
    type(/^Leave end/, "2026-08-15");
    fireEvent.click(screen.getByText(/Return guaranteed/));
    // The server's LEAVE_OVERLAPS lands on the start date.
    fireEvent.click(within(closing).getByRole("button", { name: "Review leave" }));
    await waitFor(() => expect(errorOf(/^Leave start/)).toBe("The leave that started on 2026-06-01 is still open: to record its end, send its start date"));
    fireEvent.click(within(closing).getByRole("button", { name: "Review leave" }));
    expect((await within(closing).findByLabelText("What this records")).textContent).toBe("Ends the leave that started on Jun 1, 2026 on Aug 15, 2026, return guaranteed. The stakeholder keeps one leave for that start date.");
    fireEvent.click(within(closing).getByRole("button", { name: "Record its end" }));
    expect(await screen.findByText("Leave of absence ended — Daniel Achterberg")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.recordLeaveOfAbsence))[0]!;
    expect(real.body).toMatchObject({ stakeholderId: IDS.daniel, startDate: "2026-06-01", endDate: "2026-08-15", returnGuaranteed: true });
  }, 60_000);

  it("isn't offered on the admin's own record or to read-only admins", async () => {
    renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(), { role: "admin_rw", ownStakeholderId: IDS.daniel });
    expect(await screen.findByText("This is your own record")).toBeTruthy();
    renderPage(`stakeholders/${IDS.daniel}/edit`, pageHandlers(), { role: "admin_ro" });
    expect(await screen.findByText("You have read-only access")).toBeTruthy();
    expect(screen.queryByLabelText("Record a leave of absence")).toBeNull();
  }, 60_000);
});
