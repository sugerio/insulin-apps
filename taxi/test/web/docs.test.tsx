import "./setup.ts";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DOC_TOPICS } from "../../src/app/pages/docs/topics.ts";
import { OWNER, VIEWER } from "../support/server.ts";
import { renderApp } from "./support.tsx";

describe("the in-app Docs", () => {
  it.each([
    ["an owner", OWNER],
    ["a viewer", VIEWER],
    ["a role left with no permission", { ...VIEWER, permissions: "" }],
  ])("are in the navigation for %s", async (_, as) => {
    await renderApp("/docs", { as });
    expect(within(await screen.findByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Docs" })).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "Getting started" })).toBeTruthy();
  });

  it.each(DOC_TOPICS.map((topic) => [topic.slug, topic] as const))("render the topic %s with every section", async (slug, topic) => {
    await renderApp(`/docs/${slug}`);
    expect(await screen.findByRole("heading", { level: 1, name: topic.title })).toBeTruthy();
    for (const section of topic.sections) expect(screen.getByRole("heading", { level: 2, name: section.title })).toBeTruthy();
    if (topic.generalInformation) expect(screen.getByText("General information, not advice")).toBeTruthy();
  });

  it("answers an unknown topic with page not found", async () => {
    await renderApp("/docs/nothing-here");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});
