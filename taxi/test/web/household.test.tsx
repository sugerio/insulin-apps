import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OWNER, VIEWER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

async function seedCouple(server: TestServer) {
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025 } });
  await server.call("POST", "/api/people", { as: OWNER, body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } });
  await server.call("POST", "/api/people", { as: OWNER, body: { name: "Sam Martin", relationship: "spouse", birthDate: "1987-09-15" } });
}

describe("returns", () => {
  it("starts the year and opens its household step", async () => {
    const { router } = await renderApp("/returns");
    fireEvent.click(await screen.findByRole("button", { name: "Start 2025" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/returns/2025/household"));
    expect(await screen.findByRole("heading", { name: "Your household in 2025" })).toBeTruthy();
  });

  it("doesn't offer a viewer to start a year", async () => {
    await renderApp("/returns", { as: VIEWER });
    expect(await screen.findByText(/Someone who prepares returns starts the year/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start 2025" })).toBeNull();
  });
});

describe("the household step", () => {
  it("adds yourself, then saves the year's facts and moves on", async () => {
    const { router, server } = await renderApp("/returns/2025/household", {
      seed: async (s) => void (await s.call("POST", "/api/years", { as: OWNER, body: { year: 2025 } })),
    });
    const form = await screen.findByRole("form", { name: "Add a person" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Alex Martin" } });
    fireEvent.change(within(form).getByLabelText("Birth date"), { target: { value: "1985-04-02" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("button", { name: "Edit Alex Martin" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Single" }));
    fireEvent.change(await screen.findByLabelText("Province on December 31"), { target: { value: "BC" } });
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/returns/2025/upload"));
    expect(await screen.findByText("Not available yet")).toBeTruthy();

    const stored = await (await server.call("GET", "/api/years/2025")).json();
    expect(stored).toMatchObject({ maritalStatus: "single", steps: { household: "done" } });
  });

  it("asks about preparing together only for a married or common-law couple", async () => {
    await renderApp("/returns/2025/household", { seed: seedCouple });
    fireEvent.click(await screen.findByRole("radio", { name: "Single" }));
    expect(screen.queryByRole("radio", { name: "Yes, together" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Married" }));
    expect(await screen.findByRole("radio", { name: "Yes, together" })).toBeTruthy();
    // Both adults' facts are asked for while together, only Alex's otherwise.
    expect(screen.getAllByLabelText("Province on December 31")).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Only Alex" }));
    expect(screen.getAllByLabelText("Province on December 31")).toHaveLength(1);
  });

  it("lists what is still missing, as last saved", async () => {
    await renderApp("/returns/2025/household", { seed: seedCouple });
    expect(await screen.findByText("Before you continue")).toBeTruthy();
    expect(screen.getByText("Choose your marital status on December 31.")).toBeTruthy();
  });

  it("shows a viewer the household without anything to change", async () => {
    await renderApp("/returns/2025/household", { as: VIEWER, seed: seedCouple });
    expect(await screen.findByText("Sam Martin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the household from the navigation on the latest year", async () => {
    const { router } = await renderApp("/household", { seed: seedCouple });
    await waitFor(() => expect(router.state.location.pathname).toBe("/returns/2025/household"));
  });
});
