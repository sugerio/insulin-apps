import "./setup.ts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Person } from "#shared";
import { OWNER } from "../support/server.ts";
import { renderApp } from "./support.tsx";

describe("the estimate above a step", () => {
  it("shows each return's result lines and explains one", async () => {
    await renderApp("/returns/2025/upload", {
      seed: async (server) => {
        const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
        await server.call("PUT", "/api/years/2025/household", {
          as: OWNER,
          body: { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] },
        });
      },
    });
    const summary = await screen.findByRole("group", { name: "Estimate" });
    await within(summary).findByText(/^Refund \$/);
    fireEvent.click(within(summary).getByRole("button", { name: "Estimate details" }));
    const card = await screen.findByRole("dialog");
    const line = await within(card).findByRole("button", { name: /Net federal tax/ });
    expect(line.textContent).toContain("$0.00");
    expect(within(card).getByText(/^\d+ answers assumed$/)).toBeTruthy();
    expect(within(card).getByText("RRSP contributions to deduct for 2025: $0.00")).toBeTruthy();
    fireEvent.click(line);
    expect(within(card).getByText("= line.T1.40600")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Federal tax/ })).toBeTruthy();
  });
});
