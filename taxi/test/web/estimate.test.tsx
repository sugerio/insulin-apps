import "./setup.ts";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Person } from "#shared";
import { OWNER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

/** Alex alone, single, in Ontario, step 1 saved. */
async function single(server: TestServer) {
  const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
  await server.call("PUT", "/api/years/2025/personal-info", {
    as: OWNER,
    body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] },
  });
}

/** A screen as wide as the query asks: every media query matches. */
function wideScreen() {
  const narrow = window.matchMedia;
  window.matchMedia = (query: string) => ({ ...narrow(query), matches: true });
  onTestFinished(() => {
    window.matchMedia = narrow;
  });
}

describe("the estimate above a step", () => {
  it("shows each return's result lines and explains one", async () => {
    await renderApp("/returns/2025/upload", { seed: single });
    const summary = await screen.findByRole("group", { name: "Estimate" });
    await within(summary).findByText(/^Refund \$/);
    fireEvent.click(within(summary).getByRole("button", { name: "Estimate details" }));
    const card = await screen.findByRole("dialog");
    const line = await within(card).findByRole("button", { name: /Net federal tax/ });
    expect(line.textContent).toContain("$0.00");
    expect(within(card).getByText(/^\d+ answers assumed$/)).toBeTruthy();
    expect(within(card).getByText("RRSP contributions to deduct for 2025: $0.00")).toBeTruthy();
    fireEvent.click(line);
    expect(within(card).getByText("= line.T1.41700 + line.T1.41500")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Federal tax/ })).toBeTruthy();
  });

  it("shows a resident of Quebec the federal and the Quebec result", async () => {
    await renderApp("/returns/2025/upload", {
      seed: async (server) => {
        const call = async (method: string, path: string, body: unknown) => (await server.call(method, path, { as: OWNER, body })).json();
        const camille = (await call("POST", "/api/people", { name: "Camille Roy", relationship: "self", birthDate: "1991-02-03" })) as Person;
        await call("POST", "/api/years", { year: 2025, people: [camille.id] });
        let year = (await call("PUT", "/api/years/2025/personal-info", {
          revision: 1,
          maritalStatus: "single",
          adults: [{ personId: camille.id, province: "QC", residentAllYear: true }],
        })) as { revision: number };
        year = (await call("POST", "/api/years/2025/slips", {
          revision: year.revision,
          personId: camille.id,
          type: "T4",
          issuer: "Érable Conseil",
          boxes: { 14: "62000", 17: "3744", 18: "812.20", 22: "7400", 26: "62000", 55: "306.28", 56: "62000" },
        })) as { revision: number };
        await call("POST", "/api/years/2025/slips", {
          revision: year.revision,
          personId: camille.id,
          type: "RL1",
          issuer: "Érable Conseil",
          boxes: { A: "62000", B_A: "3744", C: "812.20", E: "6900", G: "62000", H: "306.28", I: "62000" },
        });
      },
    });
    const summary = await screen.findByRole("group", { name: "Estimate" });
    await within(summary).findByText(/^Federal (refund|balance owing) \$[\d,.]+ · Quebec (refund|balance owing) \$[\d,.]+/);
    fireEvent.click(within(summary).getByRole("button", { name: "Estimate details" }));
    const card = await screen.findByRole("dialog");
    // Quebec's tax is on the TP-1, so line 42800 isn't among the result lines; the TP-1's refund and balance are.
    expect(within(card).queryByRole("button", { name: /Provincial tax/ })).toBeNull();
    expect(within(card).getAllByRole("button", { name: /Quebec/ })).toHaveLength(2);
  });

  it("shows the result lines in a column beside the step on a wide screen, which collapses into the bar and stays so", async () => {
    wideScreen();
    const { router } = await renderApp("/returns/2025/upload", { seed: single });
    const column = await screen.findByRole("complementary", { name: "Return and estimate" });
    expect(within(column).getByText("Alex Martin")).toBeTruthy();
    await within(column).findByText(/^Refund \$/);
    // Every line is in view, with no panel to open.
    fireEvent.click(await within(column).findByRole("button", { name: /Net federal tax/ }));
    expect(within(column).getByText("= line.T1.41700 + line.T1.41500")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Estimate details" })).toBeNull();

    fireEvent.click(within(column).getByRole("button", { name: "Collapse the estimate" }));
    expect(screen.queryByRole("complementary", { name: "Return and estimate" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Estimate" })).getByRole("button", { name: "Estimate details" })).toBeTruthy();
    // Another step opens collapsed too.
    await act(() => router.navigate(router.state.location.pathname.replace(/upload$/, "income")));
    await screen.findByRole("heading", { name: "Income" });
    expect(screen.queryByRole("complementary", { name: "Return and estimate" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the estimate beside the step" }));
    expect(screen.getByRole("complementary", { name: "Return and estimate" })).toBeTruthy();
  });

  it("keeps only the result in the column on Finish, which shows the lines itself", async () => {
    wideScreen();
    await renderApp("/returns/2025/finish", { seed: single });
    const column = await screen.findByRole("complementary", { name: "Return and estimate" });
    await within(column).findByText(/^Refund \$/);
    expect(within(column).queryByRole("button", { name: /Net federal tax/ })).toBeNull();
  });
});
