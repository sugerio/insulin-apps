import "./setup.ts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { ApiError } from "../../src/app/api/client.ts";
import { ApiRequestError } from "../../src/app/api/request.ts";
import { compareAmounts, exactMoney, minus, parseAmount, times } from "../../src/app/lib/amounts.ts";
import { describeChanges, formatChangeValue, transactionLabel } from "../../src/app/lib/changes.ts";
import { canonicalJson, CHANGED_MESSAGE, classifyFailure, isAmbiguous, ledgerUnmoved, useWriteFlow } from "../../src/app/lib/flow.ts";
import { createRequest, EMPTY_STAKEHOLDER, patchRequest, rebaseStakeholder, validateStakeholder } from "../../src/app/lib/stakeholderForm.ts";
import { activeEmails, emailKindLabel } from "../../src/app/lib/stakeholders.ts";
import { unsettledWrites } from "../../src/app/lib/unsettled.ts";
import { IDS, STAKEHOLDERS } from "./support/acme.ts";

// The write flows' pure parts: what an admin types read exactly, the server's changes in words with every digit
// kept, refusals sorted by what the admin can do, the frozen request and its key, and the stakeholder requests.

function refusal(status: number, error: api.ApiErrorBody["error"]): ApiRequestError {
  return new ApiRequestError(status, error.code, error.message, { error });
}

const shares = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

describe("stakeholder e-mails", () => {
  it("lists only the addresses still on the record, and says whose each is", () => {
    const own = STAKEHOLDERS.daniel.emails[0]!;
    const removed = { ...own, id: `${own.id}-removed`, removedAt: Date.UTC(2026, 9, 2) };
    const record = { ...STAKEHOLDERS.daniel, emails: [own, removed] };
    expect(activeEmails(record).map((row) => row.id)).toEqual([own.id]);
    expect(emailKindLabel({ kind: "self" })).toBe("Own address");
    expect(emailKindLabel({ kind: "contact" })).toBe("Authorized contact");
    expect(emailKindLabel({ kind: "representative" })).toBe("Representative");
  });
});

describe("typed amounts", () => {
  it("reads what admins type into canonical decimals, exactly", () => {
    expect(parseAmount("40,000")).toEqual({ ok: true, value: "40000" });
    expect(parseAmount(" 0.950 ")).toEqual({ ok: true, value: "0.95" });
    // Past 2^53 a float would read 9007199254740992; the engine's Dec keeps every digit.
    expect(parseAmount("9007199254740993.000000000001")).toEqual({ ok: true, value: "9007199254740993.000000000001" });
    expect(parseAmount("")).toBeNull();
  });

  it("refuses what isn't an amount, a zero where it must be positive, a fraction of a whole unit and a 13th decimal", () => {
    expect(parseAmount("-5")).toEqual({ ok: false, error: "Enter an amount that isn't negative." });
    expect(parseAmount("1e5")).toEqual({ ok: false, error: "Enter a number, such as 40000 or 0.95." });
    expect(parseAmount("0", { positive: true })).toEqual({ ok: false, error: "Enter an amount greater than 0." });
    expect(parseAmount("1.5", { unit: "1", unitName: "options" })).toEqual({ ok: false, error: "Use whole options." });
    expect(parseAmount("0.0000000000001")).toEqual({ ok: false, error: "Use at most 12 decimal places." });
  });

  it("multiplies, subtracts and compares without floats, and shows money as recorded", () => {
    expect(times("833", "0.185")).toBe("154.105");
    expect(times("30000", "0.31")).toBe("9300");
    expect(minus("460750", "500000")).toBe("-39250");
    expect(compareAmounts("0.1", "0.10000000001")).toBe(-1);
    expect(exactMoney("154.105")).toBe("$154.105");
    expect(exactMoney("9300")).toBe("$9,300.00");
  });
});

describe("the server's changes in words", () => {
  it("formats every figure exactly and leaves out what didn't change", () => {
    const groups = describeChanges([
      { entity: "security", id: IDS.opt1, before: { displayId: "OPT-1", status: "OUTSTANDING", outstanding: "250000", vested: "9007199254740993.000000000001" }, after: { displayId: "OPT-1", status: "CANCELLED", outstanding: "0", vested: "9007199254740993.000000000001" } },
      { entity: "capital", id: IDS.plan, before: { capitalContribution: "16147718.6" }, after: { capitalContribution: "16147718.605" } },
      { entity: "deadline", id: IDS.opt1, before: null, after: { contractual: "2027-01-21", iso: null } },
      { entity: "stakeholder", id: IDS.daniel, before: { relationship: "employee", termination: null }, after: { relationship: "ex_employee", termination: { date: "2026-10-21", type: "voluntary", vestingStopDate: "2026-10-14" } } },
      { entity: "stock_plan", id: IDS.plan, before: { x_custom_rule: "kept" }, after: { x_custom_rule: "changed" } },
    ], { names: new Map([[IDS.daniel, "Daniel Achterberg"]]), shares });
    expect(groups.map((group) => group.title)).toEqual(["OPT-1", "Company", "OPT-1 — exercise deadlines", "Daniel Achterberg", "Equity plan — terms"]);
    expect(groups[0]!.rows).toEqual([
      { key: "status", label: "Status", before: "Outstanding", after: "Cancelled" },
      { key: "outstanding", label: "Outstanding", before: "250,000", after: "0" },
    ]);
    expect(groups[1]!.rows[0]).toEqual({ key: "capitalContribution", label: "Capital contribution", before: "$16,147,718.60", after: "$16,147,718.605" });
    expect(groups[2]!.rows).toEqual([{ key: "contractual", label: "Contractual deadline", before: "—", after: "Jan 21, 2027" }]);
    expect(groups[3]!.rows.map((row) => row.after)).toEqual(["Ex Employee", "Oct 21, 2026 (Voluntary, vesting stops Oct 14, 2026)"]);
    expect(groups[4]!.rows).toEqual([{ key: "x_custom_rule", label: "X custom rule", before: "kept", after: "changed" }]);
  });

  it("shows a new grant's vesting table and names transactions", () => {
    const [vesting] = describeChanges([{ entity: "vesting", id: IDS.opt1, before: null, after: { events: [{ date: "2027-10-20", quantity: "10000", cumulative: "10000", kind: "CLIFF" }] } }], { names: new Map(), shares });
    expect(vesting!.vesting).toEqual([{ date: "2027-10-20", quantity: "10000", cumulative: "10000", kind: "CLIFF" }]);
    expect(transactionLabel("TX_EQUITY_COMPENSATION_EXERCISE")).toBe("Exercise");
    expect(transactionLabel("TX_STOCK_CLASS_SPLIT")).toBe("Stock class split");
    expect(formatChangeValue("quantity", "1234567.5", shares)).toBe("1,234,567.5");
    expect(formatChangeValue("anything", true, shares)).toBe("Yes");
  });
});

describe("refusals sorted by what the admin can do", () => {
  it("places issues and violations on their fields, and keeps the rest above the form", () => {
    const fields = { issue: (path: string) => (path === "quantity" ? "quantity" : null), violation: (violation: api.Violation) => (violation.code === "EXCEEDS_PLAN_AVAILABLE" ? "quantity" : null) };
    expect(classifyFailure(refusal(400, { code: "validation_failed", message: "Invalid", issues: [{ path: "quantity", message: "Must be greater than 0" }, { path: "note", message: "Enter a note" }] }), fields)).toEqual({
      kind: "invalid", message: "Check the highlighted fields.", fields: { quantity: "Must be greater than 0" }, unplaced: ["Enter a note"],
    });
    const refused = classifyFailure(refusal(422, { code: "invariant_violation", message: "Refused", violations: [{ code: "EXCEEDS_PLAN_AVAILABLE", message: "Too many" }, { code: "PLAN_EXPIRED", message: "The plan expired" }] }), fields);
    expect(refused).toMatchObject({ kind: "invalid", fields: { quantity: "Too many" }, unplaced: ["The plan expired"] });
  });

  it("tells warnings, stale answers, blocks and transient failures apart", () => {
    expect(classifyFailure(refusal(422, { code: "warnings_unacknowledged", message: "Acknowledge", warnings: [{ code: "PAYER_NOT_HOLDER", message: "Paid by someone else" }] }))).toEqual({ kind: "warnings", warnings: [{ code: "PAYER_NOT_HOLDER", message: "Paid by someone else" }] });
    for (const reason of ["stale_ledger", "state_changed", "stale_version"]) {
      expect(classifyFailure(refusal(409, { code: "conflict", message: "Moved", reason })).kind).toBe("stale");
    }
    const dependents = classifyFailure(refusal(409, { code: "conflict", message: "Reverse them first", reason: "dependents_exist", dependents: [{ commandId: IDS.command, type: "exercise-option", createdAt: 1 }] }));
    expect(dependents).toMatchObject({ kind: "blocked", dependents: [{ commandId: IDS.command }] });
    expect(classifyFailure(refusal(409, { code: "conflict", message: "Migrated", reason: "migrated_history" })).kind).toBe("blocked");
    expect((classifyFailure(refusal(409, { code: "conflict", message: "Reused", reason: "idempotency_key_reused" })) as { message: string }).message).toMatch(/already submitted with different details/);
    expect((classifyFailure(refusal(403, { code: "self_dealing", message: "Own" })) as { message: string }).message).toMatch(/another admin must/);
    expect((classifyFailure(refusal(404, { code: "not_found", message: "Unknown API route" })) as { message: string }).message).toBe(
      "Nothing was changed. The server couldn't find a record this refers to, or doesn't offer this action yet (Unknown API route).",
    );
    expect(classifyFailure(new ApiError(0, "network_error", "Could not reach Cap Table."))).toMatchObject({ kind: "failed", retry: true });
    expect(classifyFailure(refusal(503, { code: "unavailable", message: "D1 down" }))).toMatchObject({ kind: "failed", retry: true });
  });
});

describe("the write cycle", () => {
  type Request = { securityId: string; quantity: string };
  const unreachable = () => new ApiError(0, "network_error", "Could not reach Cap Table.");

  it("freezes the request at review, previews it without a key, and sends exactly it with the reviewed seq", async () => {
    let form: Request = { securityId: "s1", quantity: "100" };
    const previewed: Request[] = [];
    const sent: { body: unknown; key: string }[] = [];
    const { result, rerender } = renderHook(() => useWriteFlow({
      request: () => ({ ...form }),
      preview: async (request: Request) => {
        previewed.push(request);
        return { ledgerSeq: 412 };
      },
      body: ({ request, preview }) => ({ ...request, expectedLedgerSeq: preview!.ledgerSeq }),
      send: async (body, key) => {
        sent.push({ body, key });
        return "recorded";
      },
    }));
    await act(() => result.current.review());
    expect(result.current.phase).toBe("review");
    expect(result.current.request).toEqual({ securityId: "s1", quantity: "100" });
    await act(() => result.current.commit());
    expect(result.current.phase).toBe("done");
    expect(sent).toEqual([{ body: { securityId: "s1", quantity: "100", expectedLedgerSeq: 412 }, key: expect.any(String) }]);
    expect(previewed).toEqual([{ securityId: "s1", quantity: "100" }]);
    form = { securityId: "s1", quantity: "999" };
    rerender();
    expect(result.current.phase).toBe("done");
  });

  it("drops the preview when what the request depends on changes during the review", async () => {
    let form: Request = { securityId: "s1", quantity: "100" };
    const sent: unknown[] = [];
    const { result, rerender } = renderHook(() => useWriteFlow({
      request: () => ({ ...form }),
      preview: async () => ({ ledgerSeq: 412 }),
      body: ({ request }) => request,
      send: async (body) => {
        sent.push(body);
        return "recorded";
      },
    }));
    await act(() => result.current.review());
    // A lookup that finished late (or an answer) changes the request while the preview is shown.
    form = { securityId: "s1", quantity: "120" };
    await act(async () => rerender());
    expect(result.current.phase).toBe("edit");
    expect(result.current.preview).toBeNull();
    expect(result.current.problem).toEqual({ kind: "changed", message: CHANGED_MESSAGE });
    await act(() => result.current.commit());
    expect(sent).toHaveLength(0);
    await act(() => result.current.review());
    await act(() => result.current.commit());
    expect(sent).toEqual([{ securityId: "s1", quantity: "120" }]);
  });

  it("keeps the body and its key frozen after a lost answer, until a retry or a check settles it", async () => {
    let form: Request = { securityId: "s1", quantity: "100" };
    const keys: string[] = [];
    const bodies: unknown[] = [];
    let attempts = 0;
    const { result, rerender } = renderHook(() => useWriteFlow({
      request: () => ({ ...form }),
      preview: async () => ({ ledgerSeq: 412 }),
      body: ({ request, preview }) => ({ ...request, expectedLedgerSeq: preview!.ledgerSeq }),
      send: async (body, key) => {
        keys.push(key);
        bodies.push(body);
        attempts += 1;
        if (attempts <= 2) throw unreachable();
        return "recorded";
      },
      reconcile: async () => "not_recorded" as const,
    }));
    await act(() => result.current.review());
    await act(() => result.current.commit());
    expect(result.current.phase).toBe("unresolved");
    expect(result.current.problem).toMatchObject({ kind: "unresolved", checked: false });
    expect(result.current.locked).toBe(true);
    expect(result.current.canCheck).toBe(true);
    // Back is refused while the outcome is unknown.
    act(() => result.current.edit());
    expect(result.current.phase).toBe("unresolved");
    // The retry resends the same bytes with the same key, even if the form behind it changed.
    form = { securityId: "s1", quantity: "999" };
    rerender();
    await act(() => result.current.commit());
    expect(bodies[1]).toEqual(bodies[0]);
    expect(keys[1]).toBe(keys[0]);
    expect(result.current.phase).toBe("unresolved");
    // The check finds nothing recorded, so the request is no longer frozen: the changed form needs a new review, and
    // its body gets a new key.
    await act(() => result.current.check());
    expect(result.current.phase).toBe("edit");
    expect(result.current.problem).toEqual({ kind: "changed", message: CHANGED_MESSAGE });
    await act(() => result.current.review());
    await act(() => result.current.commit());
    expect(result.current.phase).toBe("done");
    expect(bodies[2]).toEqual({ securityId: "s1", quantity: "999", expectedLedgerSeq: 412 });
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("returns to the review when the check finds nothing recorded and nothing changed", async () => {
    let attempts = 0;
    const { result } = renderHook(() => useWriteFlow({
      request: () => ({ securityId: "s1" }),
      preview: async () => ({ ledgerSeq: 412 }),
      body: ({ request }) => request,
      send: async () => {
        attempts += 1;
        if (attempts === 1) throw unreachable();
        return "recorded";
      },
      reconcile: async () => "not_recorded" as const,
    }));
    await act(() => result.current.review());
    await act(() => result.current.commit());
    await act(() => result.current.check());
    expect(result.current.phase).toBe("review");
    expect(result.current.problem).toMatchObject({ kind: "failed", message: expect.stringMatching(/^The server has no record of it/) });
    await act(() => result.current.commit());
    expect(result.current.phase).toBe("done");
  });

  it("holds the app while an outcome is unknown, and lets go once it is known or the write is gone", async () => {
    let attempts = 0;
    const flow = () => useWriteFlow({
      request: () => ({ securityId: "s1" }),
      preview: null,
      body: ({ request }) => request,
      send: async () => {
        attempts += 1;
        if (attempts % 2 === 1) throw unreachable();
        return "recorded";
      },
    });
    const { result } = renderHook(flow);
    await act(() => result.current.review());
    expect(unsettledWrites()).toBe(0);
    await act(() => result.current.commit());
    expect(result.current.unsettled).toBe(true);
    expect(unsettledWrites()).toBe(1);
    await act(() => result.current.commit());
    expect(result.current.phase).toBe("done");
    expect(unsettledWrites()).toBe(0);
    // A write left unresolved lets go when its component is gone.
    const left = renderHook(flow);
    await act(() => left.result.current.review());
    await act(() => left.result.current.commit());
    expect(unsettledWrites()).toBe(1);
    left.unmount();
    expect(unsettledWrites()).toBe(0);
  });

  it("stays frozen when the check can't rule the write out", async () => {
    const { result } = renderHook(() => useWriteFlow({
      request: () => ({ securityId: "s1" }),
      preview: async () => ({ ledgerSeq: 412 }),
      body: ({ request }) => request,
      send: async (): Promise<string> => {
        throw new ApiRequestError(503, "unavailable", "D1 is unavailable", null);
      },
      reconcile: async () => "unknown" as const,
    }));
    await act(() => result.current.review());
    await act(() => result.current.commit());
    await act(() => result.current.check());
    expect(result.current.phase).toBe("unresolved");
    expect(result.current.problem).toMatchObject({ kind: "unresolved", checked: true });
  });

  it("words chosen refusals as the flow asks", async () => {
    const { result } = renderHook(() => useWriteFlow({
      request: () => ({ commandId: 7 }),
      preview: null,
      body: ({ request }) => request,
      send: async () => {
        throw refusal(403, { code: "forbidden", message: "A different admin must record this" });
      },
      messages: { forbidden: "Another admin must approve it." },
    }));
    await act(() => result.current.review());
    await act(() => result.current.commit());
    expect(result.current.problem).toEqual({ kind: "blocked", message: "Another admin must approve it." });
  });

  it("rules a ledger command out only when the head hasn't moved", async () => {
    expect(await ledgerUnmoved(async () => ({ ledgerSeq: 412 }), 412)).toBe("not_recorded");
    expect(await ledgerUnmoved(async () => ({ ledgerSeq: 413 }), 412)).toBe("unknown");
    const gone = refusal(422, { code: "invariant_violation", message: "Refused", violations: [{ code: "SECURITY_NOT_OUTSTANDING", message: "Not outstanding" }] });
    expect(await ledgerUnmoved(async () => { throw gone; }, 412)).toBe("unknown");
    await expect(ledgerUnmoved(async () => { throw unreachable(); }, 412)).rejects.toThrow("Could not reach");
  });

  it("reloads what the request read after a stale answer and reviews the rebuilt request, with a new key", async () => {
    let version = 1;
    const keys: string[] = [];
    const bodies: unknown[] = [];
    const { result } = renderHook(() => useWriteFlow({
      request: () => ({ version, comments: "Board observer" }),
      preview: null,
      body: ({ request }) => request,
      send: async (body, key) => {
        keys.push(key);
        bodies.push(body);
        if (bodies.length === 1) throw refusal(409, { code: "conflict", message: "Reload it", reason: "stale_version" });
        return "saved";
      },
      refresh: async () => {
        version = 2;
      },
    }));
    await act(() => result.current.review());
    await act(() => result.current.commit());
    await waitFor(() => expect(result.current.phase).toBe("review"));
    expect(result.current.problem).toEqual({ kind: "stale", message: "Reload it" });
    expect(result.current.request).toEqual({ version: 2, comments: "Board observer" });
    await act(() => result.current.commit());
    expect(bodies).toEqual([{ version: 1, comments: "Board observer" }, { version: 2, comments: "Board observer" }]);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("asks for each warning to be acknowledged and sends the acknowledgement with the frozen request", async () => {
    let previews = 0;
    const { result } = renderHook(() => useWriteFlow({
      request: () => ({ securityId: "s1" }),
      preview: async () => ({ ledgerSeq: ++previews, warnings: [{ code: "PAYMENT_EXCEEDS_COST", message: "Refund the excess" }] }),
      body: ({ request, acknowledge }) => ({ ...request, acknowledge: [...acknowledge] }),
      send: async (body) => body.acknowledge.join(","),
    }));
    await act(() => result.current.review());
    expect(result.current.acknowledgedAll).toBe(false);
    act(() => result.current.acknowledge("PAYMENT_EXCEEDS_COST", true));
    await act(() => result.current.commit());
    expect(result.current.result).toBe("PAYMENT_EXCEEDS_COST");
  });

  it("tells ambiguous failures from refusals, and writes canonical JSON", () => {
    expect(isAmbiguous(unreachable())).toBe(true);
    expect(isAmbiguous(new ApiRequestError(503, "unavailable", "Down", null))).toBe(true);
    expect(isAmbiguous(new ApiRequestError(200, "internal", "Unreadable answer", null))).toBe(true);
    expect(isAmbiguous(refusal(409, { code: "conflict", message: "Moved", reason: "stale_ledger" }))).toBe(false);
    expect(isAmbiguous(refusal(403, { code: "forbidden", message: "Not allowed" }))).toBe(false);
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
});

describe("stakeholder requests", () => {
  it("builds a create request and a PATCH of only what changed", () => {
    const values = { ...EMPTY_STAKEHOLDER, legalName: "Theo Marchetti", email: "Theo.Marchetti@Mailbox.example ", line1: "1 Main St", city: "Oakland", country: "us", countryOfResidence: "us" };
    expect(validateStakeholder(values, "create")).toEqual({});
    const request = createRequest(values);
    expect(request).toMatchObject({ displayName: "Theo Marchetti", address: { line1: "1 Main St", city: "Oakland", country: "US" }, countryOfResidence: "US", emails: [{ email: "Theo.Marchetti@Mailbox.example", kind: "self" }] });
    expect("acknowledge" in request).toBe(false);
    const daniel = STAKEHOLDERS.daniel;
    expect(patchRequest({ ...EMPTY_STAKEHOLDER, ...valuesFrom(daniel), phone: "+1 510 555 0199" }, daniel)).toEqual({ version: 1, phone: "+1 510 555 0199" });
    expect(validateStakeholder({ ...EMPTY_STAKEHOLDER, legalName: "X", email: "x@example.test", countryOfResidence: "USA" }, "create")).toEqual({ countryOfResidence: "Use a two-letter country code, e.g. US." });
  });

  it("clears an emptied optional field and an emptied address with null, and leaves the rest out", () => {
    const daniel = { ...STAKEHOLDERS.daniel, phone: "+1 510 555 0100", address: { line1: "1 Main St", city: "Oakland", country: "US" } };
    const values = { ...EMPTY_STAKEHOLDER, ...valuesFrom(daniel), phone: "", line1: "", city: "", country: "", comments: "  " };
    expect(validateStakeholder(values, "edit")).toEqual({});
    const patch = patchRequest(values, daniel);
    // Comments were empty already: whitespace changes nothing. Required fields are never sent as null.
    expect(patch).toEqual({ version: daniel.version, phone: null, address: null });
  });

  it("keeps a concurrent change to a field the admin didn't edit, and reports it", () => {
    const base = { ...STAKEHOLDERS.daniel, phone: "+1 510 555 0100" };
    const fresh = { ...base, phone: "+1 510 555 0199", comments: "Moved to the Oakland office", version: 2 };
    const edited = { ...EMPTY_STAKEHOLDER, ...valuesFrom(base), displayName: "Dan Achterberg", comments: "Prefers e-mail" };
    const { values, changes } = rebaseStakeholder(edited, base, fresh);
    expect(values.phone).toBe("+1 510 555 0199");
    expect(values.displayName).toBe("Dan Achterberg");
    expect(values.comments).toBe("Prefers e-mail");
    expect(changes).toEqual([
      { field: "phone", before: "+1 510 555 0100", after: "+1 510 555 0199", conflict: false },
      { field: "comments", before: "", after: "Moved to the Oakland office", conflict: true },
    ]);
    expect(patchRequest(values, fresh)).toEqual({ version: 2, displayName: "Dan Achterberg", comments: "Prefers e-mail" });
  });

  it("sends an institution's contact with its name and role, and an individual's own address", () => {
    const fund = createRequest({ ...EMPTY_STAKEHOLDER, kind: "institution", legalName: "Synthetic Fund", email: "ops@fund.example", contactName: "Ops desk", contactRole: "Operations" });
    expect(fund.emails).toEqual([{ email: "ops@fund.example", kind: "contact", contactName: "Ops desk", contactRole: "Operations" }]);
    expect(validateStakeholder({ ...EMPTY_STAKEHOLDER, kind: "institution", legalName: "Synthetic Fund" }, "create")).toEqual({ email: "Enter a valid e-mail address." });
    expect(createRequest({ ...EMPTY_STAKEHOLDER, legalName: "Theo" }).emails).toEqual([]);
  });
});

function valuesFrom(stakeholder: api.Stakeholder) {
  return {
    kind: stakeholder.kind, legalName: stakeholder.legalName ?? stakeholder.displayName, displayName: "", relationship: stakeholder.relationship, hireDate: stakeholder.hireDate ?? "",
    issuerAssignedId: stakeholder.issuerAssignedId ?? "", phone: stakeholder.phone ?? "", line1: stakeholder.address?.line1 ?? "", line2: stakeholder.address?.line2 ?? "",
    city: stakeholder.address?.city ?? "", region: stakeholder.address?.region ?? "", postalCode: stakeholder.address?.postalCode ?? "", country: stakeholder.address?.country ?? "",
    countryOfResidence: stakeholder.countryOfResidence ?? "", comments: stakeholder.comments ?? "",
  };
}
