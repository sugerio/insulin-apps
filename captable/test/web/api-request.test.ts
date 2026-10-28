import "./setup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "#shared";
import { onUnauthorized } from "../../src/app/api/client.ts";
import { ApiRequestError, apiRequest, attachmentName, CONTRACT_MISMATCH, routePath, saveFile } from "../../src/app/api/request.ts";
import { capTable, org, ORG_ID, uuid } from "./support/acme.ts";
import { apiError } from "./support/mockApi.ts";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

let unauthorized: ReturnType<typeof vi.fn<() => void>>;
let unsubscribe: () => void;
beforeEach(() => {
  unauthorized = vi.fn<() => void>();
  unsubscribe = onUnauthorized(unauthorized);
});
afterEach(() => unsubscribe());

describe("typed API client", () => {
  it("builds the path and query from the route and parses the answer with its schema", async () => {
    const fetch = vi.fn().mockResolvedValue(json(capTable("ownership")));
    vi.stubGlobal("fetch", fetch);
    const result = await apiRequest(api.routes.getCapTable, { params: { orgId: ORG_ID }, query: { asOf: "2025-12-31", tab: "ownership" } });
    expect(result.metrics.fullyDiluted).toBe("24312120");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`/api/orgs/${ORG_ID}/cap-table?asOf=2025-12-31&tab=ownership`);
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeNull();
  });

  it("refuses a malformed id before any request, as the server answers 404 for it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(apiRequest(api.routes.getStakeholder, { params: { orgId: ORG_ID, id: "new" } })).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(() => routePath(api.routes.getOrg, { orgId: "../admin" })).toThrow(ApiRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a query that breaks the route's schema", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(apiRequest(api.routes.getCapTable, { params: { orgId: ORG_ID }, query: { asOf: "2025-13-45" } })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("sends one Idempotency-Key per intent on writes, reuses a given one, and none on dry runs", async () => {
    const fetch = vi.fn().mockImplementation(async () => json(org({ displayName: "Acme Robotics Labs", version: 4 })));
    vi.stubGlobal("fetch", fetch);
    const body = { version: 3, displayName: "Acme Robotics Labs" };
    await apiRequest(api.routes.patchOrg, { params: { orgId: ORG_ID }, body });
    await apiRequest(api.routes.patchOrg, { params: { orgId: ORG_ID }, body, idempotencyKey: "intent-0001" });
    const first = new Headers(fetch.mock.calls[0]![1].headers);
    const second = new Headers(fetch.mock.calls[1]![1].headers);
    expect(first.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.get("Content-Type")).toBe("application/json");
    expect(second.get("Idempotency-Key")).toBe("intent-0001");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(body);

    fetch.mockResolvedValueOnce(apiError(422, "invariant_violation", "Blocked", { violations: [{ code: "NO_PRESUMPTIVELY_VALID_409A", message: "No 409A" }] }));
    const dryRun = apiRequest(api.routes.cancelSecurity, {
      params: { orgId: ORG_ID }, dryRun: true,
      body: { effectiveDate: "2026-10-21", securityId: uuid(6, 1), reason: "HOLDER_WAIVER", note: "Holder waived", documentId: uuid(10, 1), confirmation: "OPT-1" },
    });
    await expect(dryRun).rejects.toBeInstanceOf(ApiRequestError);
    const [url, init] = fetch.mock.calls[2]!;
    expect(url).toBe(`/api/orgs/${ORG_ID}/commands/cancel-security?dryRun=true`);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeNull();
  });

  it("refuses a body that breaks the route's schema without sending it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const failure = apiRequest(api.routes.patchOrg, { params: { orgId: ORG_ID }, body: { version: 3, displayName: "" } });
    await expect(failure).rejects.toMatchObject({ code: "validation_failed" });
    const error = (await failure.catch((cause: unknown) => cause)) as ApiRequestError;
    expect(error.body?.error.issues?.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps the error envelope and conflict reasons", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(apiError(409, "conflict", "This changed — review again", { reason: "stale_ledger" }))
      .mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("offline")));
    const conflict = await apiRequest(api.routes.getDashboard, { params: { orgId: ORG_ID } }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ApiRequestError);
    expect(conflict).toMatchObject({ status: 409, code: "conflict", reason: "stale_ledger", message: "This changed — review again" });
    expect((conflict as ApiRequestError).body?.error.reason).toBe("stale_ledger");
    await expect(apiRequest(api.routes.getDashboard, { params: { orgId: ORG_ID } })).rejects.toMatchObject({ status: 502, code: "internal", body: null });
    await expect(apiRequest(api.routes.getDashboard, { params: { orgId: ORG_ID } })).rejects.toMatchObject({ status: 0, code: "network_error" });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("reports a 401 to the app, which shows the console page, and never navigates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiError(401, "unauthenticated", "Session expired")));
    await expect(apiRequest(api.routes.getDashboard, { params: { orgId: ORG_ID } })).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("refuses an answer that breaks the contract instead of rendering it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...capTable("ownership"), metrics: { fullyDiluted: 24312120 } })));
    await expect(apiRequest(api.routes.getCapTable, { params: { orgId: ORG_ID } })).rejects.toMatchObject({ code: "internal", message: CONTRACT_MISMATCH });
    expect(error).toHaveBeenCalled();
  });

  it("passes aborts through untouched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")));
    await expect(apiRequest(api.routes.getDashboard, { params: { orgId: ORG_ID } })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("saves a download as an attachment under the server's file name", async () => {
    const headers = {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": "attachment; filename*=UTF-8''AcmeRobotics_CapTable_2026-10-21.xlsx",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("PK", { status: 200, headers })));
    const createObjectURL = vi.fn(() => "blob:report");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const name = await saveFile(api.routes.runReport, { params: { orgId: ORG_ID, reportKey: "cap-table" }, query: { asOf: "2026-10-21", format: "xlsx" } }, "fallback.xlsx");
    expect(name).toBe("AcmeRobotics_CapTable_2026-10-21.xlsx");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });

  it("refuses a download that isn't an attachment", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<script>", { status: 200, headers: { "Content-Type": "text/html" } })));
    await expect(saveFile(api.routes.runReport, { params: { orgId: ORG_ID, reportKey: "audit-log" } }, "x.csv")).rejects.toMatchObject({ message: CONTRACT_MISMATCH });
  });

  it("sends a form body as multipart fields, one part per file, with the browser's own Content-Type", async () => {
    const answer = {
      runId: uuid(50, 1),
      preview: {
        detectedFiles: [], currency: "USD", problems: [], openingBalances: [], assumptions: [],
        totals: { uploaded: null, app: { fullyDiluted: "0", issuedAndOutstanding: "0", byClass: {}, byPlan: {}, byHolder: {}, bySecurity: {} }, reconciliation: [] },
        canImport: false, suggestedAsOfDate: null,
        counts: { stakeholders: 0, shareClasses: 0, equityPlans: 0, securities: 0, commands: 0, transactions: 0 },
      },
    };
    const fetch = vi.fn().mockImplementation(async () => json(answer, 201));
    vi.stubGlobal("fetch", fetch);
    const raw = new File(["PK raw"], "Raw Cap Table.xlsx");
    const vesting = new File(["PK vesting"], "Vesting Details.xlsx");
    await apiRequest(api.routes.previewImport, { body: { source: "pulley", files: [raw, vesting], asOfDate: "2026-10-20", timezone: "UTC", jurisdiction: "US-DE", fiscalYearEnd: "12-31" } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/import/preview");
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("source")).toBe("pulley");
    expect(body.get("asOfDate")).toBe("2026-10-20");
    expect(body.getAll("files").map((part) => (part as File).name)).toEqual(["Raw Cap Table.xlsx", "Vesting Details.xlsx"]);
    expect(await (body.getAll("files")[1] as File).text()).toBe("PK vesting");
    const headers = new Headers(init.headers);
    // multipart/form-data with its boundary is the browser's to write; a preview writes nothing, so it carries no key.
    expect(headers.get("Content-Type")).toBeNull();
    expect(headers.get("Idempotency-Key")).toBeNull();

    fetch.mockImplementation(async () => json({ orgId: uuid(1, 2), counts: answer.preview.counts }));
    await apiRequest(api.routes.commitImport, { params: { runId: uuid(50, 1) }, body: { files: [raw], asOfDate: "2026-10-20", timezone: "UTC", jurisdiction: "US-DE", fiscalYearEnd: "12-31" }, idempotencyKey: "import-0001" });
    const [commitUrl, commitInit] = fetch.mock.calls[1]!;
    expect(commitUrl).toBe(`/api/import/runs/${uuid(50, 1)}/commit`);
    expect(new Headers(commitInit.headers).get("Idempotency-Key")).toBe("import-0001");
    expect((commitInit.body as FormData).has("source")).toBe(false);
  });

  it("refuses a form body the contract refuses without sending it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const failure = apiRequest(api.routes.previewImport, { body: { source: "template", files: [new File(["a"], "a.xlsx"), new File(["b"], "b.xlsx")], timezone: "UTC", jurisdiction: "US-DE", fiscalYearEnd: "12-31" } });
    await expect(failure).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    const error = (await failure.catch((cause: unknown) => cause)) as ApiRequestError;
    expect(error.body?.error.issues?.map((issue) => issue.message)).toEqual(["Choose exactly one Cap Table spreadsheet"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads RFC 5987 file names", () => {
    expect(attachmentName("attachment; filename*=UTF-8''Nov%202025%20Valuation.pdf")).toBe("Nov 2025 Valuation.pdf");
    expect(attachmentName("inline")).toBeNull();
    expect(attachmentName(null)).toBeNull();
  });
});
