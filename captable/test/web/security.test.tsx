import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IDS, uuid } from "./support/acme.ts";
import { securityHandlers as handlers } from "./support/securities.ts";
import { base, renderPage } from "./support/render.tsx";

function definitionOf(label: string): HTMLElement {
  const term = screen.getAllByRole("term").find((item) => item.textContent === label);
  if (!term) throw new Error(`No term ${label}`);
  return term.nextElementSibling as HTMLElement;
}

describe("option detail", () => {
  it("shows the overview, vesting, ISO/NSO split, details and post-termination exercise", async () => {
    renderPage(`securities/${IDS.opt1}`, handlers);
    expect(await screen.findByRole("heading", { name: "OPT-1 Options", level: 1 })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Acme RoboticsOptionsDaniel AchterbergOPT-1");
    expect(definitionOf("Granted").textContent).toBe("300,000 options");
    expect(definitionOf("Vested and unexercised").textContent).toBe("218,750 options");
    expect(definitionOf("Exercise price").textContent).toBe("$0.10");
    await screen.findByText("$0.95");
    expect(definitionOf("Current FMV").textContent).toBe("$0.95 (Nov 2025 Valuation · Expiring soon)");
    expect(definitionOf("Expiration date").textContent).toBe("Apr 14, 2033");
    expect(await screen.findByText(/268,750 of the total 300,000 options \(89\.6%\) have vested\. Next: 6,250 on Nov 1, 2026\./)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Cumulative vested options over time for OPT-1" })).toBeTruthy();
    expect(screen.getByText("Full vesting schedule (37 events)")).toBeTruthy();
    const schedule = screen.getByRole("table", { name: "Vesting schedule" });
    expect(within(schedule).getAllByText("from Pulley")).toHaveLength(37);
    expect(within(schedule).getByText(/Mar 1, 2024 · cliff/)).toBeTruthy();
    expect(definitionOf("Schedule").textContent).toBe("4 years monthly, 1-year cliff (25%)");
    expect(definitionOf("Cliff").textContent).toBe("12 months");
    const split = await screen.findByRole("table", { name: "ISO/NSO split" });
    const totals = within(split).getAllByRole("row").at(-1)!;
    expect(within(totals).getByText("$30,000.00")).toBeTruthy();
    expect(within(split).getAllByText("· partly exercised")).toHaveLength(1);
    expect(definitionOf("Option type").textContent).toBe("ISO");
    expect(definitionOf("Consent document").textContent).toBe("Board consent 2023-04-14.pdf");
    expect(definitionOf("Execution status").textContent).toBe("Executed");
    expect(within(definitionOf("Exercises")).getByRole("link", { name: "CS-7" }).getAttribute("href")).toBe(`${base}/securities/${IDS.cs7}`);
    expect(definitionOf("Voluntary").textContent).toBe("3 months inherited from the plan");
    expect(definitionOf("With cause").textContent).toBe("0 days inherited from the plan");
    expect(await screen.findByText("Exercised 50,000 ISO → CS-7 · Check")).toBeTruthy();
    expect(screen.getByRole("button", { name: "OPT-1 Option Agreement.pdf" })).toBeTruthy();
    expect(screen.getByText("Imported from Pulley", { selector: "summary" })).toBeTruthy();
  }, 60_000); // the largest page test: give it room on a busy machine

  it("shows the deadlines of a terminated holder's option and its non-US exemption", async () => {
    renderPage(`securities/${IDS.opt21}`, handlers);
    await screen.findByRole("heading", { name: "OPT-21 Options", level: 1 });
    expect(definitionOf("Contractual deadline").textContent).toBe("Nov 30, 2026 (40 days)3 months after involuntary termination");
    expect(definitionOf("ISO deadline").textContent).toBe("— (NSO)");
    expect(definitionOf("Federal exemption").textContent).toBe("Non-US");
    expect(definitionOf("Country").textContent).toBe("CA");
    expect(definitionOf("Early exercise allowed").textContent).toBe("Yes");
    expect(await within(definitionOf("Stakeholder")).findByText("Terminated")).toBeTruthy();
    expect(await screen.findByText("Stopped")).toBeTruthy();
  });

  it("marks an execution-pending grant and offers read-write admins Cancel, Mark executed and Upload document", async () => {
    renderPage(`securities/${IDS.opt49}`, handlers, { role: "admin_rw" });
    await screen.findByRole("heading", { name: "OPT-49 Options", level: 1 });
    expect(screen.getAllByText("Execution pending").length).toBeGreaterThan(0);
    expect(definitionOf("Board approval date").textContent).toBe("not recorded in Pulley");
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    const labels = items.map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.startsWith("Record exercise"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Mark executed"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Reverse last transaction"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Upload document"))).toBe(true);
    // Every write is wired: nothing in the menu is disabled.
    for (const item of items) expect(item.getAttribute("aria-disabled")).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("gives owners Reverse last transaction", async () => {
    renderPage(`securities/${IDS.opt1}`, handlers);
    await screen.findByRole("heading", { name: "OPT-1 Options", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Reverse last transaction/ })).toBeTruthy();
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Record exercise/ })).toBeTruthy();
  });

  it("shows no write actions on the admin's own holding", async () => {
    renderPage(`securities/${IDS.opt1}`, handlers, { role: "admin_rw", ownStakeholderId: IDS.daniel });
    expect(await screen.findByText("Your own holding")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("masks the holder's e-mail and hides actions for read-only admins", async () => {
    renderPage(`securities/${IDS.opt1}`, handlers, { role: "admin_ro" });
    await screen.findByRole("heading", { name: "OPT-1 Options", level: 1 });
    expect(await screen.findByText("d•••@mailbox.example")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
  });
});

describe("share, warrant and SAFE detail", () => {
  it("shows a founder share with its certificate, vesting and 83(b)", async () => {
    renderPage(`securities/${IDS.cs1}`, handlers);
    await screen.findByRole("heading", { name: "CS-1 Shares", level: 1 });
    expect(definitionOf("Price per share").textContent).toBe("$0.0001");
    expect(await screen.findByText("$0.00001")).toBeTruthy();
    expect(definitionOf("Capital contribution").textContent).toBe("$400.00");
    expect(definitionOf("Certificate").textContent).toContain("Unsigned PDF (migrated)");
    expect(screen.getByRole("button", { name: "Download certificate CS-1" })).toBeTruthy();
    expect(await screen.findByText(/4,000,000 of the total 4,000,000 shares \(100\.0%\) have vested/)).toBeTruthy();
    expect(definitionOf("Repurchase right").textContent).toContain("not recorded in Pulley");
    expect(definitionOf("Rule 144 date").textContent).toBe("Feb 15, 2022");
    expect(definitionOf("Legends").textContent).toBe("L1 · Securities Act legend, L2 · Transfer restrictions");
    expect(await screen.findByText("Filed on Mar 1, 2021 (proof on file)")).toBeTruthy();
  });

  it("shows where exercise shares came from", async () => {
    renderPage(`securities/${IDS.cs7}`, handlers);
    await screen.findByRole("heading", { name: "CS-7 Shares", level: 1 });
    expect(screen.getByText("Exercised from OPT-1")).toBeTruthy();
    expect(within(definitionOf("Exercised from")).getByRole("link", { name: "OPT-1" })).toBeTruthy();
    expect(definitionOf("Board approval date").textContent).toBe("n/a (exercise of an approved grant)");
    // The 83(b) line waits for the elections lookup: it never says "Not required" before the answer is in.
    await waitFor(() => expect(definitionOf("83(b)").textContent).toBe("Not required"));
  });

  it("shows a warrant with its imported exercise provisions", async () => {
    renderPage(`securities/${IDS.war1}`, handlers, { role: "admin_rw" });
    await screen.findByRole("heading", { name: "WAR-1 Warrant", level: 1 });
    expect(definitionOf("Exercise price").textContent).toBe("$0.31");
    expect(definitionOf("Expiration date").textContent).toBe("May 1, 2031");
    expect(definitionOf("Exercise provisions (imported)").textContent).toBe("Cash or net exercise allowed (section 2.3 of the warrant).");
    expect(screen.getByText(/The app doesn't record warrant exercises/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent?.split("Not available")[0])).toEqual(["Cancel", "Upload document", "Reverse last transaction"]);
  });

  it("shows a converted SAFE's terms and conversion per the closing memo", async () => {
    renderPage(`convertibles/${IDS.safe1}`, handlers);
    expect(await screen.findByRole("heading", { name: "SAFE-1", level: 1 })).toBeTruthy();
    expect(screen.getByText("Converted to PS-1")).toBeTruthy();
    expect(await screen.findByText(/Converted on Mar 31, 2023 into/)).toBeTruthy();
    expect(screen.getByText(/at \$0\.48 per share \(per closing memo\)/)).toBeTruthy();
    expect(definitionOf("Valuation cap").textContent).toBe("$6,000,000");
    expect(definitionOf("Discount").textContent).toBe("20%");
    expect(definitionOf("Principal").textContent).toBe("$250,000");
    expect(definitionOf("Pro rata").textContent).toBe("Yes");
    expect(definitionOf("MFN").textContent).toBe("No");
    expect(await screen.findByText("520,833")).toBeTruthy();
    expect(definitionOf("Funds received").textContent).toBe("Apr 4, 2022");
    expect(await screen.findByRole("button", { name: "Download SAFE-1 Agreement.pdf" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem")).toHaveLength(1);
  });

  it("answers an unknown security with the not-found state", async () => {
    renderPage(`securities/${uuid(6, 999)}`, handlers);
    expect(await screen.findByText("This security does not exist.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toBeTruthy();
  });
});
