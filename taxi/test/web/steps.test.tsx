import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import { OWNER, VIEWER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

const APPLIES = ["hasSelfEmployment", "hasRentalIncome", "hasPensionIncome", "hasEiBenefits", "hasForeignIncome", "soldProperty", "hasChildCare"];

/** Alex alone, single, in Ontario, step 1 saved; optionally with What applies answered and a T4. */
async function seed(server: TestServer, { applies = false, slip = false } = {}) {
  const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
  let year = (await (
    await server.call("PUT", "/api/years/2025/household", {
      as: OWNER,
      body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] },
    })
  ).json()) as TaxYear;
  if (applies) {
    const answers = Object.fromEntries(APPLIES.map((id) => [id, false]));
    year = (await (await server.call("PUT", "/api/years/2025/answers", { as: OWNER, body: { revision: year.revision, personId: alex.id, answers } })).json()) as TaxYear;
  }
  if (slip) {
    await server.call("POST", "/api/years/2025/slips", {
      as: OWNER,
      body: { revision: year.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 16: "3361.75", 18: "984", 22: "9000" } },
    });
  }
  return alex;
}

const estimate = async (server: TestServer) => (await (await server.call("GET", "/api/years/2025/estimate")).json()) as Estimate;

describe("What applies", () => {
  it("asks yes or no for each kind of income, and moves on once all are answered", async () => {
    const { router, server } = await renderApp("/returns/2025/applies", { seed: (s) => seed(s).then(() => undefined) });
    const continueButton = await screen.findByRole("button", { name: "Save and continue" });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("radio", { name: "Yes" })[0]!);
    for (const radio of screen.getAllByRole("radio", { name: "No" }).slice(1)) fireEvent.click(radio);
    expect(screen.getByText("Not handled by this app yet.")).toBeTruthy();
    fireEvent.click(continueButton);
    await waitFor(() => expect(router.state.location.pathname).toBe("/returns/2025/confirm"));
    const answers = Object.values((await estimate(server)).input.answers)[0]!;
    expect(answers).toMatchObject({ hasSelfEmployment: true, hasChildCare: false });
  });
});

describe("Confirm", () => {
  it("adds a slip by hand from its boxes, and confirms it", async () => {
    const { server } = await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add a slip" }));
    const form = screen.getByRole("form", { name: "Add a slip" });
    fireEvent.change(within(form).getByLabelText("Issued by"), { target: { value: "Maple Corp" } });
    fireEvent.change(within(form).getByLabelText(/Box 14/), { target: { value: "60,000.00" } });
    fireEvent.change(within(form).getByLabelText(/Box 22/), { target: { value: "9000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("T4 · Maple Corp")).toBeTruthy();
    expect(screen.getByText("To confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 slip" }));
    expect(await screen.findByText("Confirmed")).toBeTruthy();
    expect((await estimate(server)).input.slips).toEqual([expect.objectContaining({ type: "T4", boxes: { 14: "60000", 22: "9000" } })]);
  });

  it("lists the boxes in the order printed", async () => {
    await renderApp("/returns/2025/confirm", { seed: (s) => seed(s, { applies: true }).then(() => undefined) });
    fireEvent.click(await screen.findByRole("button", { name: "Add a slip" }));
    const boxes = within(screen.getByRole("form", { name: "Add a slip" }))
      .getAllByText(/^Box /)
      .map((label) => label.textContent);
    expect(boxes.slice(0, 4)).toEqual(["Box 14", "Box 16", "Box 16A", "Box 18"]);
  });

  it("shows a viewer the slips without anything to change", async () => {
    await renderApp("/returns/2025/confirm", { as: VIEWER, seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    expect(await screen.findByText("T4 · Maple Corp")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a slip" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
  });
});

describe("Deductions", () => {
  it("asks only what the return reads, and saves a blank as zero", async () => {
    const { router, server } = await renderApp("/returns/2025/deductions", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    const rrsp = await screen.findByLabelText("RRSP contributions to deduct for 2025");
    expect(screen.queryByLabelText(/Tuition to transfer/)).toBeNull();
    expect(screen.queryByLabelText(/spouse's or partner's 2025 net income/)).toBeNull();
    fireEvent.change(rrsp, { target: { value: "2,500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/returns/2025/finish"));
    const answers = Object.values((await estimate(server)).input.answers)[0]!;
    expect(answers).toMatchObject({ rrspDeduction: "2500", donations: "0", medicalExpenses: "0" });
  });
});

describe("Finish", () => {
  it("shows the refund, the key lines with why, and what is left to check", async () => {
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, { applies: true, slip: true }).then(() => undefined) });
    expect(await screen.findByText("Refund")).toBeTruthy();
    expect(screen.getByText("1 slip is not confirmed yet.")).toBeTruthy();
    expect(screen.getByText(/^Not answered yet: RRSP contributions/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Net federal tax/ }));
    expect(screen.getByText("= line.T1.40600")).toBeTruthy();
  });
});
