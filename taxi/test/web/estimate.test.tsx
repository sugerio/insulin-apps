import "./setup.ts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Person } from "#shared";
import { OWNER } from "../support/server.ts";
import { renderApp } from "./support.tsx";

describe("the estimate beside a step", () => {
  it("shows each return's result lines and explains one", async () => {
    await renderApp("/returns/2025/upload", {
      seed: async (server) => {
        const alex = (await (await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as Person;
        await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id] } });
      },
    });
    const card = (await screen.findByRole("heading", { name: "Federal estimate" })).closest("[data-slot=card]") as HTMLElement;
    const line = await within(card).findByRole("button", { name: /Net federal tax/ });
    expect(line.textContent).toContain("$0.00");
    expect(within(card).getByText("Assumed: RRSP contributions to deduct for 2025, $0.00")).toBeTruthy();
    fireEvent.click(line);
    expect(within(card).getByText("= max(0, line.T1.40400 - line.T1.35000)")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Federal tax on taxable income/ })).toBeTruthy();
  });
});
