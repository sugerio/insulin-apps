import "./setup.ts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "./support.tsx";

// The shell's two levels: each collapses to its icons, and this browser remembers each level's choice.

const stored = () => JSON.parse(window.localStorage.getItem("insulin-nav") ?? "null") as unknown;
const settingsColumn = () => document.getElementById("insulin-nav-section")!;

describe("the navigation", () => {
  it("collapses Settings' column to its icons, keeping each level's choice", async () => {
    await renderApp("/returns");
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const column = settingsColumn();
    expect(column.hidden).toBe(false);
    expect(column.getAttribute("data-collapsible")).toBe("");

    fireEvent.click(within(column).getByRole("button", { name: "Collapse Settings" }));
    expect(column.getAttribute("data-collapsible")).toBe("icon");
    // Collapsed, each page is its icon, named by its tooltip.
    expect(within(column).getByTitle("People")).toBeTruthy();
    expect(stored()).toEqual({ l1: "expanded", l2: "collapsed" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(stored()).toEqual({ l1: "collapsed", l2: "collapsed" });
    fireEvent.click(within(column).getByRole("button", { name: "Expand Settings" }));
    expect(column.getAttribute("data-collapsible")).toBe("");
    expect(stored()).toEqual({ l1: "collapsed", l2: "expanded" });
  });

  it("opens Settings collapsed when this browser last chose so", async () => {
    window.localStorage.setItem("insulin-nav", JSON.stringify({ l1: "expanded", l2: "collapsed" }));
    await renderApp("/returns");
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(settingsColumn().getAttribute("data-collapsible")).toBe("icon");
    expect(within(settingsColumn()).getByRole("button", { name: "Expand Settings" })).toBeTruthy();
  });
});
