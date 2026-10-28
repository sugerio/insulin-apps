import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "#shared";
import { TODAY } from "./support/acme.ts";
import { apiError, mock, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

// Company › Reports: every export the server produces, each saved as a download (a blob and `<a download>`, which the
// console's sandboxed frame allows), never opened in a new window.

function attachment(name: string): Response {
  return new Response("PK", {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}

describe("reports", () => {
  it("lists every export with the formats it comes in, and is reachable from the Company group", async () => {
    renderPage("reports", []);
    const table = await screen.findByRole("table", { name: "Reports" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent?.replace("As of the date above", ""))).toEqual([
      "Cap table", "Raw cap table", "Stakeholders", "Vesting details", "Exercise history", "Audit log",
    ]);
    expect(within(rows[5]!).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["CSV"]);
    expect(within(rows[1]!).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["CSV", "Excel", "JSON"]);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Reports" }).getAttribute("href")).toBe(`${base}/reports`);
  });

  it("downloads a report as of the chosen date, with personal data for those who may see it", async () => {
    const createObjectURL = vi.fn(() => "blob:report");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { callsTo } = renderPage("reports", [mock(api.routes.runReport, (request: MockRequest) => attachment(`AcmeRobotics_CapTable_${request.query.get("asOf")}.xlsx`))]);
    fireEvent.change(await screen.findByLabelText("As of"), { target: { value: "2025-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Download the cap table as Excel" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    const [call] = callsTo(api.routes.runReport);
    expect(call!.url.pathname).toBe(`${base.replace("/companies", "/api/orgs")}/reports/cap-table`);
    expect(Object.fromEntries(call!.query)).toEqual({ format: "xlsx", asOf: "2025-12-31", includePii: "true" });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("asks for no date on the whole logs, and leaves personal data out for editors who may not see it", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { callsTo } = renderPage("reports", [mock(api.routes.runReport, () => attachment(`AcmeRobotics_AuditLog_${TODAY}.csv`))], { role: "admin_ro" });
    expect(await screen.findByText(/Personal data .* is left out for your access level/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download the audit log as CSV" }));
    await waitFor(() => expect(callsTo(api.routes.runReport)).toHaveLength(1));
    expect(Object.fromEntries(callsTo(api.routes.runReport)[0]!.query)).toEqual({ format: "csv" });
  });

  it("says which report couldn't be downloaded", async () => {
    renderPage("reports", [mock(api.routes.runReport, () => apiError(404, "not_found", "Unknown API route"))]);
    fireEvent.click(await screen.findByRole("button", { name: "Download the stakeholders as CSV" }));
    expect(await screen.findByText("Stakeholders: This export isn't available.")).toBeTruthy();
  });

  it("refuses a date after today", async () => {
    renderPage("reports", []);
    fireEvent.change(await screen.findByLabelText("As of"), { target: { value: "2099-01-01" } });
    expect(screen.getByText("Choose a date up to today.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download the cap table as Excel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Download the audit log as CSV" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
