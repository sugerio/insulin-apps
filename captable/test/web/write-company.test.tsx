import "./setup.ts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "#shared";
import { org, uuid } from "./support/acme.ts";
import { choose, errorOf, keysOf, LOST, refused, staleVersion, type, unavailable } from "./support/flows.ts";
import { mock, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

// Company › Profile & Settings writes: the profile, the holder contact and display.
// Owners and admins; each write is reviewed, sends the company's version, keeps its key across a lost answer and reads
// the company again after a stale one.

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const NO_PAYMENT = null;
const PAYMENT: api.PaymentInstruction = {
  details: { bankName: "First Example Bank", beneficiaryName: "Acme Robotics, Inc.", beneficiaryAddress: "400 Harbor Way, Suite 12, Oakland, CA", accountNumber: "••••4321", routingNumber: "000000000", referenceFormat: "EX-<grant>-<initials>" },
  updatedBy: "Rachel Ostrowski", updatedAt: Date.UTC(2026, 9, 2, 17),
};

/** The org as the server holds it now: getOrg answers it, and a test changes it as the server would. */
function orgState(initial: api.Org) {
  const state = { current: initial };
  return { state, response: () => json(state.current) };
}

function companyHandlers(_options: Record<string, never> = {}, ...extra: MockHandler[]): MockHandler[] {
  return [
    ...extra,
    mock(api.routes.getPaymentInstructions, NO_PAYMENT),
    mock(api.routes.listSignatories, { items: [] }),
  ];
}

describe("company profile", () => {
  it("reviews only the changed fields and retries a lost answer with the same key", async () => {
    const server = orgState(org());
    let answers = 0;
    const patch = mock(api.routes.patchOrg, () => {
      answers += 1;
      if (answers === 1) return unavailable();
      server.state.current = org({ displayName: "Acme Robotics Labs", fiscalYearEnd: "06-30", version: 4 });
      return server.state.current;
    });
    const { callsTo } = renderPage("company", companyHandlers({}, patch), { orgResponse: server.response });
    fireEvent.click(await screen.findByRole("button", { name: "Edit the company profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit company profile" });
    type(/^Company name/, "Acme Robotics Labs");
    choose("Fiscal year end", "06-30");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    const changes = await within(dialog).findByLabelText("Changes");
    expect(changes.textContent).toContain("Company nameAcme Robotics→Acme Robotics Labs");
    expect(changes.textContent).toContain("Fiscal year endDecember 31→June 30");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));
    expect(await within(dialog).findByText(LOST)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Company profile saved")).toBeTruthy();
    const calls = callsTo(api.routes.patchOrg);
    expect(calls.map((call) => call.body)).toEqual([
      { version: 3, displayName: "Acme Robotics Labs", fiscalYearEnd: "06-30" },
      { version: 3, displayName: "Acme Robotics Labs", fiscalYearEnd: "06-30" },
    ]);
    expect(keysOf(calls)[0]).toBe(keysOf(calls)[1]);
    // The page shows the saved profile (the org is read again).
    await waitFor(() => expect(screen.getAllByText("Acme Robotics Labs").length).toBeGreaterThan(0));
  }, 60_000);

  it("holds in-app navigation while an outcome is unknown, and never asks the browser to confirm leaving", async () => {
    const listen = vi.spyOn(window, "addEventListener");
    const patch = mock(api.routes.patchOrg, () => unavailable());
    const { router } = renderPage("company", companyHandlers({}, patch));
    fireEvent.click(await screen.findByRole("button", { name: "Edit the company profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit company profile" });
    type(/^Company name/, "Acme Robotics Labs");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Save profile" }));
    expect(await within(dialog).findByText(LOST)).toBeTruthy();
    // A browser prompt would interrupt the console the app runs in: there is none, and leaving isn't held back.
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
    expect(listen.mock.calls.filter(([event]) => event === "beforeunload")).toEqual([]);
    // Inside the app, a navigation waits with a word on why.
    const here = router.state.location.pathname;
    await act(() => router.navigate(`${base}/dashboard`));
    expect(await screen.findByText("A write's outcome isn't known yet. Try again, or Check what was recorded, before you leave this page.")).toBeTruthy();
    expect(router.state.location.pathname).toBe(here);
  }, 60_000);

  it("after a stale answer keeps the admin's edit over the fresh org and names what someone else changed", async () => {
    const server = orgState(org());
    let answers = 0;
    const patch = mock(api.routes.patchOrg, () => {
      answers += 1;
      if (answers === 1) {
        // Another admin saved the legal name meanwhile.
        server.state.current = org({ legalName: "Acme Robotics Holdings, Inc.", version: 4 });
        return staleVersion();
      }
      return org({ legalName: "Acme Robotics Holdings, Inc.", displayName: "Acme Robotics Labs", version: 5 });
    });
    const { callsTo } = renderPage("company", companyHandlers({}, patch), { orgResponse: server.response });
    fireEvent.click(await screen.findByRole("button", { name: "Edit the company profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit company profile" });
    type(/^Company name/, "Acme Robotics Labs");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Save profile" }));
    const serverSide = await within(dialog).findByLabelText("Changed on the server");
    expect(serverSide.textContent).toContain("Legal nameAcme Robotics, Inc.→Acme Robotics Holdings, Inc.");
    expect((within(dialog).getByLabelText(/^Legal name/) as HTMLInputElement).value).toBe("Acme Robotics Holdings, Inc.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Company profile saved")).toBeTruthy();
    const calls = callsTo(api.routes.patchOrg);
    // The second request carries the fresh version and only the admin's own change: the legal name is never overwritten.
    expect(calls[1]!.body).toEqual({ version: 4, displayName: "Acme Robotics Labs" });
    expect(keysOf(calls)[1]).not.toBe(keysOf(calls)[0]);
  }, 60_000);

  it("offers the share unit only while the ledger is empty, and puts SHARE_UNIT_FROZEN on its field", async () => {
    const server = orgState(org({ shareUnitFrozen: false }));
    const patch = mock(api.routes.patchOrg, () => refused([{ code: "SHARE_UNIT_FROZEN", message: "The share unit cannot change after the ledger is populated" }]));
    renderPage("company", companyHandlers({}, patch), { orgResponse: server.response });
    fireEvent.click(await screen.findByRole("button", { name: "Edit the company profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit company profile" });
    type(/^Share unit/, "0.0001");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect((await within(dialog).findByLabelText("Changes")).textContent).toContain("Share unit1→0.0001");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(errorOf(/^Share unit/)).toBe("The share unit cannot change after the ledger is populated"));
  }, 60_000);

  it("disables the share unit once the ledger has transactions", async () => {
    renderPage("company", companyHandlers());
    fireEvent.click(await screen.findByRole("button", { name: "Edit the company profile" }));
    await screen.findByRole("dialog", { name: "Edit company profile" });
    expect((screen.getByLabelText(/^Share unit/) as HTMLInputElement).disabled).toBe(true);
  });

  it("checks the profile before sending anything", async () => {
    const { callsTo } = renderPage("company", companyHandlers());
    fireEvent.click(await screen.findByRole("button", { name: "Edit the company profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit company profile" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Company name/)).toBe("Nothing has changed.");
    type(/^Company name/, "");
    type(/^Country/, "USA");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Company name/)).toBe("Enter the company name.");
    expect(errorOf(/^Country/)).toBe("Use a two-letter country code, e.g. US.");
    expect(callsTo(api.routes.patchOrg)).toHaveLength(0);
  });
});

describe("holder contact and display", () => {
  it("saves the holder contact as one settings section", async () => {
    const patch = mock(api.routes.patchOrg, () => org({ version: 4 }, { companyContact: { name: "Equity desk", email: "equity-desk@acmerobotics.example" } }));
    const { callsTo } = renderPage("company", companyHandlers({}, patch));
    fireEvent.click(await screen.findByRole("button", { name: "Edit the company contact" }));
    const dialog = await screen.findByRole("dialog", { name: "Company contact for holders" });
    type(/^Name/, "Equity desk");
    type(/^Role e-mail/, "equity-desk");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Role e-mail/)).toBe("Enter a valid e-mail address.");
    type(/^Role e-mail/, "equity-desk@acmerobotics.example");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect((await within(dialog).findByLabelText("Review")).textContent).toContain("(instead of Equity team · equity@acmerobotics.example)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save contact" }));
    expect(await screen.findByText("Company contact saved — holders see it in the portal")).toBeTruthy();
    expect(callsTo(api.routes.patchOrg)[0]!.body).toEqual({ version: 3, settings: { companyContact: { name: "Equity desk", email: "equity-desk@acmerobotics.example" } } });
  });

  it("saves the display decimals, and has nothing to save when they are unchanged", async () => {
    const patch = mock(api.routes.patchOrg, () => org({ version: 4 }, { display: { shareDecimals: 2, priceDecimals: 2 } }));
    const { callsTo } = renderPage("company", companyHandlers({}, patch));
    fireEvent.click(await screen.findByRole("button", { name: "Edit the display decimals" }));
    const dialog = await screen.findByRole("dialog", { name: "Display" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect((await within(dialog).findByLabelText("Review")).textContent).toContain("Nothing to save");
    expect((within(dialog).getByRole("button", { name: "Save display" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    choose("Share quantity decimals", "2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Save display" }));
    expect(await screen.findByText("Display saved")).toBeTruthy();
    expect(callsTo(api.routes.patchOrg)[0]!.body).toEqual({ version: 3, settings: { display: { shareDecimals: 2, priceDecimals: 2 } } });
  });
});

describe("payment instructions", () => {
  /**
   * The instructions as the server holds them: GET answers them; a save must name the `updatedAt` it replaces (409
   * stale_version otherwise), replaces them, and is replayed for its key; `answer` may refuse a save or lose its answer.
   */
  function paymentServer(initial: api.PaymentInstruction | null, answer: (saves: number) => Response | null = () => null) {
    const state = { current: initial, saves: 0 };
    const receipts = new Map<string, api.PaymentInstruction>();
    const handlers = [
      mock(api.routes.getPaymentInstructions, () => state.current),
      mock(api.routes.setPaymentInstructions, (request: MockRequest) => {
        const key = request.headers.get("Idempotency-Key") ?? "";
        const receipt = receipts.get(key);
        if (receipt) return receipt;
        state.saves += 1;
        const body = request.body as api.SetPaymentInstructionsRequest;
        const early = answer(state.saves);
        if (early && early.status < 500) return early;
        if (body.updatedAt !== (state.current?.updatedAt ?? null)) return staleVersion();
        const recorded = { details: body.details, updatedBy: "Morgan Ellis", updatedAt: Date.UTC(2026, 9, 21, 17) + state.saves };
        state.current = recorded;
        receipts.set(key, recorded);
        return early ?? recorded;
      }),
      mock(api.routes.listSignatories, { items: [] }),
    ];
    return { state, handlers };
  }

  it("sets them up: checks the form, reviews, and saves exactly the details typed", async () => {
    const server = paymentServer(NO_PAYMENT);
    const { callsTo } = renderPage("company", server.handlers, { role: "admin_rw" });
    expect(await screen.findByText("No payment instructions yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up the payment instructions" }));
    const dialog = await screen.findByRole("dialog", { name: "Set payment instructions" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Bank/)).toBe("Enter the bank.");
    expect(errorOf(/^Reference format/)).toBe("Enter the reference format.");
    type(/^Bank/, "First Example Bank");
    type(/^Beneficiary\W*$/, "Acme Robotics, Inc.");
    type(/^Beneficiary address/, "400 Harbor Way, Suite 12, Oakland, CA");
    type(/^Account number/, " 000123454321 ");
    type(/^Routing number/, "12345");
    type(/^SWIFT/, "exmpus00");
    type(/^Reference format/, "EX-<grant>-<initials>");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Routing number/)).toBe("A routing number has 9 digits.");
    type(/^Routing number/, "000000000");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect((await within(dialog).findByLabelText("Review")).textContent).toContain("Holders see these details on How to exercise:");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save instructions" }));
    expect(await screen.findByText("Payment instructions saved — holders see them on How to exercise")).toBeTruthy();
    const [call] = callsTo(api.routes.setPaymentInstructions);
    expect(call!.body).toEqual({
      details: {
        bankName: "First Example Bank", beneficiaryName: "Acme Robotics, Inc.", beneficiaryAddress: "400 Harbor Way, Suite 12, Oakland, CA",
        accountNumber: "000123454321", routingNumber: "000000000", swift: "EXMPUS00", referenceFormat: "EX-<grant>-<initials>",
      },
      updatedAt: null,
    });
    expect(call!.headers.get("Idempotency-Key")).toBeTruthy();
    // The card shows what the server holds now.
    expect(await screen.findByText("EXMPUS00")).toBeTruthy();
    expect(screen.getByText(/by Morgan Ellis/)).toBeTruthy();
  }, 60_000);

  it("edits them: asks for the whole masked number, and keeps one key across a lost answer", async () => {
    const server = paymentServer(PAYMENT, (saves) => (saves === 1 ? unavailable() : null));
    const { callsTo } = renderPage("company", server.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Edit the payment instructions" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit payment instructions" });
    expect((within(dialog).getByLabelText(/^Bank/) as HTMLInputElement).value).toBe("First Example Bank");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Account number/)).toBe("Enter the whole account number: the shown one is masked.");
    type(/^Account number/, "000123454321");
    type(/^Bank/, "Second Example Bank");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect((await within(dialog).findByLabelText("Review")).textContent).toContain("instead of the ones Rachel Ostrowski saved Oct 2, 2026");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save instructions" }));
    expect(await within(dialog).findByText(LOST)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Payment instructions saved — holders see them on How to exercise")).toBeTruthy();
    const calls = callsTo(api.routes.setPaymentInstructions);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(keysOf(calls)[0]).toBe(keysOf(calls)[1]);
    expect((calls[0]!.body as api.SetPaymentInstructionsRequest).details).toMatchObject({ bankName: "Second Example Bank", accountNumber: "000123454321", routingNumber: "000000000" });
    expect((calls[0]!.body as api.SetPaymentInstructionsRequest).updatedAt).toBe(PAYMENT.updatedAt);
    expect(await screen.findByText("Second Example Bank")).toBeTruthy();
  }, 60_000);

  it("says when nothing has changed, and finds a lost save already recorded", async () => {
    const full = { ...PAYMENT, details: { ...PAYMENT.details, accountNumber: "000123454321" } };
    const server = paymentServer(full, () => unavailable());
    renderPage("company", server.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Edit the payment instructions" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit payment instructions" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/^Bank/)).toBe("Nothing has changed.");
    type(/^Reference format/, "EX-<grant>");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Save instructions" }));
    expect(await within(dialog).findByText(LOST)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Check what was recorded" }));
    expect(await screen.findByText("Payment instructions saved — holders see them on How to exercise")).toBeTruthy();
    expect(server.state.saves).toBe(1);
    expect(await screen.findByText("EX-<grant>")).toBeTruthy();
  }, 60_000);

  it("after a stale answer, reads the current version, keeps only the admin's own edit and saves over that version", async () => {
    const full = { ...PAYMENT, details: { ...PAYMENT.details, accountNumber: "000123454321" } };
    const server = paymentServer(full);
    const { callsTo } = renderPage("company", server.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Edit the payment instructions" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit payment instructions" });
    // Another admin saves a new bank meanwhile.
    const theirs = { details: { ...full.details, bankName: "Third Example Bank" }, updatedBy: "Freya Lindqvist", updatedAt: Date.UTC(2026, 9, 21, 15) };
    server.state.current = theirs;
    type(/^Reference format/, "EX-<grant>");
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Save instructions" }));
    const review = () => within(dialog).getByLabelText("Review").textContent ?? "";
    await waitFor(() => expect(review()).toContain("instead of the ones Freya Lindqvist saved"));
    expect(review()).toContain("Third Example Bank");
    expect((within(dialog).getByLabelText(/^Reference format/) as HTMLInputElement).value).toBe("EX-<grant>");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save instructions" }));
    expect(await screen.findByText("Payment instructions saved — holders see them on How to exercise")).toBeTruthy();
    const calls = callsTo(api.routes.setPaymentInstructions);
    expect(calls.map((call) => (call.body as api.SetPaymentInstructionsRequest).updatedAt)).toEqual([full.updatedAt, theirs.updatedAt]);
    expect((calls[1]!.body as api.SetPaymentInstructionsRequest).details).toMatchObject({ bankName: "Third Example Bank", referenceFormat: "EX-<grant>" });
    expect(keysOf(calls)[1]).not.toBe(keysOf(calls)[0]);
  }, 60_000);

  it("offers an editor no payment write", async () => {
    renderPage("company", [mock(api.routes.getPaymentInstructions, NO_PAYMENT), mock(api.routes.listSignatories, { items: [] })], { role: "admin_ro" });
    expect(await screen.findByText("No payment instructions yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /payment instructions/ })).toBeNull();
  });
});

describe("who edits, and the read-only sections", () => {
  it("gives an editor no settings write", async () => {
    renderPage("company", companyHandlers(), { role: "admin_ro" });
    expect(await screen.findByText("View only — owners and admins edit.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  it("shows no access list, e-mail settings or held e-mails: access is managed in the console", async () => {
    renderPage("company", companyHandlers());
    expect(await screen.findByText("Owners and admins edit; editors view.")).toBeTruthy();
    const sections = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(sections).getAllByRole("link").map((link) => link.textContent)).toEqual(["Company profile", "Signatories", "Holder contact", "Payment instructions", "Display"]);
  });

  it("shows an editor the payment instructions read-only", async () => {
    renderPage("company", [mock(api.routes.getPaymentInstructions, PAYMENT), mock(api.routes.listSignatories, { items: [] })], { role: "admin_ro" });
    const card = (await screen.findByText("First Example Bank")).closest("section, .card") as HTMLElement;
    expect(within(card).getByText("EX-<grant>-<initials>")).toBeTruthy();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("says when there are no payment instructions yet", async () => {
    renderPage("company", companyHandlers());
    expect(await screen.findByText("No payment instructions yet.")).toBeTruthy();
  });
});
