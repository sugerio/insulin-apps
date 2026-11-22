import "./setup.ts";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Person, TaxYear } from "#shared";
import { OWNER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

// A long name or issuer with no space in it (the API allows 100 characters) wraps, or is cut off with an ellipsis,
// rather than widening the page past a phone's screen and pushing its buttons off it. jsdom has no layout, so this
// checks that each element showing one has the classes that let it wrap.

const NAME = `Alexandria${"x".repeat(80)}`;
const ISSUER = `Maple${"y".repeat(80)}`;

/** Whether the text in `element` can wrap anywhere (or is truncated), from a class on it or a nearby ancestor. */
function wraps(element: HTMLElement): boolean {
  let at: HTMLElement | null = element;
  for (let depth = 0; at && depth < 4; depth += 1, at = at.parentElement) {
    if (/(^|\s)(wrap-anywhere|truncate)(\s|$)/.test(at.className)) return true;
  }
  return false;
}

/** Every element whose own text shows `text`, but not those that only name it for screen readers. */
const showing = (text: string) => screen.getAllByText(new RegExp(text)).filter((element) => !element.closest(".sr-only"));

/** NAME (and Sam, so there is a switcher), married, in Ontario, with a T4 from ISSUER: the year then. */
async function seed(server: TestServer) {
  const add = async (name: string, relationship: string, birthDate: string) =>
    (await (await server.call("POST", "/api/people", { as: OWNER, body: { name, relationship, birthDate } })).json()) as Person;
  const alex = await add(NAME, "self", "1985-04-02");
  const sam = await add("Sam Martin", "spouse", "1987-09-15");
  await server.call("POST", "/api/years", { as: OWNER, body: { year: 2025, people: [alex.id, sam.id] } });
  const adults = [alex, sam].map((person) => ({ personId: person.id, province: "ON", residentAllYear: true }));
  const year = (await (await server.call("PUT", "/api/years/2025/personal-info", { as: OWNER, body: { revision: 1, maritalStatus: "married", adults } })).json()) as TaxYear;
  await server.call("POST", "/api/years/2025/slips", { as: OWNER, body: { revision: year.revision, personId: alex.id, type: "T4", issuer: ISSUER, boxes: { 14: "60000", 22: "9000" } } });
}

describe("a long name or issuer", () => {
  it("wraps on Returns", async () => {
    await renderApp("/returns", { seed });
    await screen.findAllByText(NAME);
    const onReturns = showing(NAME);
    expect(onReturns.length).toBeGreaterThanOrEqual(3);
    for (const element of onReturns) expect(wraps(element), element.outerHTML.slice(0, 120)).toBe(true);
  });

  it("wraps on the Profile", async () => {
    await renderApp("/profile", { seed });
    await screen.findAllByText(NAME);
    for (const element of showing(NAME)) expect(wraps(element), element.outerHTML.slice(0, 120)).toBe(true);
  });

  it("wraps above a return's steps and in its slips, where the switcher can shrink", async () => {
    await renderApp("/returns/2025/confirm", { seed });
    await screen.findAllByText(new RegExp(ISSUER));
    for (const element of [...showing(NAME), ...showing(ISSUER)]) expect(wraps(element), element.outerHTML.slice(0, 120)).toBe(true);
    expect(screen.getByRole("button", { name: `Return of ${NAME}: switch return` }).className).toMatch(/(^|\s)min-w-0(\s|$)/);
  });

  it("wraps in Income's slips", async () => {
    await renderApp("/returns/2025/income", { seed });
    await screen.findAllByText(new RegExp(ISSUER));
    for (const element of showing(ISSUER)) expect(wraps(element), element.outerHTML.slice(0, 120)).toBe(true);
  });

  it("wraps in the question before removing a person", async () => {
    const child = `Jordan${"z".repeat(80)}`;
    await renderApp("/profile", {
      seed: async (server) => {
        await seed(server);
        await server.call("POST", "/api/people", { as: OWNER, body: { name: child, relationship: "child", birthDate: "2019-06-20" } });
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: `Remove ${child}` }));
    const question = (await screen.findByText(`Remove ${child}?`)).closest<HTMLElement>("[role=status]")!;
    const named = within(question).getAllByText(new RegExp(child));
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const element of named) expect(wraps(element), element.outerHTML.slice(0, 120)).toBe(true);
  });

  it("wraps in the question before deleting a file, and in what is left before filing", async () => {
    const file = `${NAME}.pdf`;
    const { router } = await renderApp("/returns/2025/upload", {
      seed: async (server) => {
        await seed(server);
        await server.call("POST", "/api/years/2025/documents", {
          as: OWNER,
          raw: new TextEncoder().encode("%PDF-1.4 x") as Uint8Array<ArrayBuffer>,
          headers: { "Content-Type": "application/pdf", "X-File-Name": file },
        });
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: `Delete ${file}` }));
    const question = await screen.findByText(`Delete ${file}?`);
    expect(wraps(question), question.outerHTML.slice(0, 120)).toBe(true);

    // On Sam's Finish, what is left on the other return is named with its person.
    const sam = screen.getByRole("button", { name: /switch return/ });
    fireEvent.keyDown(sam, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Sam Martin/ }));
    await act(() => router.navigate(router.state.location.pathname.replace(/upload$/, "finish")));
    const before = await screen.findByRole("region", { name: "Before you file" });
    const named = within(before).getAllByText(new RegExp(NAME));
    expect(named.length).toBeGreaterThan(0);
    for (const element of named) expect(wraps(element), element.outerHTML.slice(0, 120)).toBe(true);
  });
});
