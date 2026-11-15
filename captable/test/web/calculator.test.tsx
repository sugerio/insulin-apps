import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { optionsForPercent } from "../../src/app/components/SharesCalculatorDialog.tsx";
import { capTable, IDS, SEED_CLASS, stockClass, stockPlan, TODAY, uuid } from "./support/acme.ts";
import { mock } from "./support/mockApi.ts";
import { renderPage } from "./support/render.tsx";

// The % shares calculator on the Equity plans page: read-only, exact decimals, an estimate.

const ECHO = { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0" };
const SERIES_A = stockClass({ id: uuid(4, 9), name: "Series A-1 Preferred", classType: "PREFERRED", defaultIdPrefix: "PA", originalIssuePrice: "1.25" });
const FMV = { date: TODAY, stockClassId: IDS.common, fmv: { valuationId: IDS.v5, valuationName: "Nov 2025 Valuation", pricePerShare: "0.95", splitAdjusted: false, status: "expiring_soon" as const } };

function handlers(fmv: api.FmvResponse = FMV) {
  return [
    mock(api.routes.listStockPlans, { ...ECHO, items: [stockPlan()] }),
    mock(api.routes.getCapTable, capTable("ownership")),
    mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS, SERIES_A] }),
    mock(api.routes.getFmv, fmv),
  ];
}

async function open() {
  fireEvent.click(await screen.findByRole("button", { name: "% shares calculator" }));
  return screen.findByRole("dialog", { name: "% shares calculator" });
}

describe("% shares calculator", () => {
  it("floors the options for a target share of fully diluted, without floating point", () => {
    expect(optionsForPercent("24312120", "0.25")).toBe("60780"); // 60,780.3
    expect(optionsForPercent("24312120", "100")).toBe("24312120");
    expect(optionsForPercent("999999999999999999", "0.000001")).toBe("9999999999"); // 9,999,999,999.99…
  });

  it("shows options, value at a preferred price and cost at today's 409A FMV, labelled an estimate", async () => {
    const { callsTo } = renderPage("equity-plans", handlers());
    const dialog = await open();
    expect(within(dialog).getByText(/Estimate — not tax advice/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Target % of fully diluted"), { target: { value: "0.25" } });
    const estimate = await within(dialog).findByLabelText("Estimate");
    const value = (term: string | RegExp) => within(estimate).getByText(term).nextElementSibling?.textContent;
    expect(value("Options needed")).toBe("60,780");
    expect(value("Share of fully diluted")).toBe("0.2500%");
    // The highest original issue price first: Series A-1 at $1.25.
    expect(value(/^Value at Series A-1 Preferred price/)).toBe("$75,975.00");
    expect(value(/^Cost to exercise at the 409A FMV \(\$0\.95\)/)).toBe("$57,741.00");
    expect(callsTo(api.routes.getFmv)[0]?.query.get("date")).toBe(TODAY);

    const price = within(dialog).getByRole("combobox", { name: "Value at the price of" });
    // A shadcn/ui (Radix) Select: open it from the keyboard, then pick the option.
    fireEvent.keyDown(price, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Series Seed Preferred/ }));
    await waitFor(() => expect(value(/^Value at Series Seed Preferred price/)).toBe("$48,624.00"));
    // Only preferred classes with an original issue price are offered.
    fireEvent.keyDown(price, { key: "Enter" });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Series Seed Preferred ($0.80)", "Series A-1 Preferred ($1.25)"]);
    expect(screen.queryByRole("option", { name: /Common Stock/ })).toBeNull();
  });

  it("gives focus back to its button when it closes", async () => {
    renderPage("equity-plans", handlers());
    const button = await screen.findByRole("button", { name: "% shares calculator" });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "% shares calculator" });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("refuses a percentage it can't use and says when no 409A is in effect", async () => {
    renderPage("equity-plans", handlers({ ...FMV, fmv: null }));
    const dialog = await open();
    const input = within(dialog).getByLabelText("Target % of fully diluted");
    fireEvent.change(input, { target: { value: "150" } });
    expect(within(dialog).getByText("Enter a percentage above 0 and at most 100.")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Estimate")).toBeNull();
    fireEvent.change(input, { target: { value: "1/2" } });
    expect(within(dialog).getByText(/Enter a percentage such as 0\.25/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "1" } });
    const estimate = await within(dialog).findByLabelText("Estimate");
    expect(within(estimate).getByText("No 409A is in effect today")).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
