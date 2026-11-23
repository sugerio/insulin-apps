import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import { officialForms, type FormSource } from "../../src/app/server/lib/forms.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";
import { OWNER, VIEWER, type TestServer } from "../support/server.ts";
import { catchDownloads, holdRequests, renderApp } from "./support.tsx";

/** Alex, single in Ontario (or Quebec), with a T4; `finished` answers what the return assumes and confirms the slip. */
async function seed(
  server: TestServer,
  finished: boolean,
  { province = "ON", residentAllYear = true }: { province?: "ON" | "QC"; residentAllYear?: boolean | null } = {},
): Promise<void> {
  const call = async <T,>(method: string, path: string, body: unknown) => (await (await server.call(method, path, { as: OWNER, body })).json()) as T;
  const alex = await call<Person>("POST", "/api/people", { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" });
  await call("POST", "/api/years", { year: 2025, people: [alex.id] });
  let year = await call<TaxYear>("PUT", "/api/years/2025/personal-info", { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province, residentAllYear }] });
  year = await call<TaxYear>("POST", "/api/years/2025/slips", { revision: year.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } });
  if (province === "QC") {
    year = await call<TaxYear>("POST", "/api/years/2025/slips", { revision: year.revision, personId: alex.id, type: "RL1", issuer: "Maple Corp", boxes: { A: "60000", E: "6900" } });
  }
  if (!finished) return;
  const estimate = (await (await server.call("GET", "/api/years/2025/estimate", { as: OWNER })).json()) as Estimate;
  const answers = Object.fromEntries(estimate.result.people[0]!.estimates.map((item) => [item.question, item.assumed]));
  year = await call<TaxYear>("PUT", "/api/years/2025/answers", { revision: year.revision, personId: alex.id, answers });
  await call("POST", "/api/years/2025/slips/confirm", { revision: year.revision, personId: alex.id });
}

/** Blank pages for each form, as the server's stand-in for canada.ca and revenuquebec.ca; the urls asked for. */
function standIn(): FormSource & { fetched: string[] } {
  const rules = rulesFor(2025)!;
  const fetched: string[] = [];
  return {
    fetched,
    checkHash: false,
    async fetch(url) {
      fetched.push(url);
      const form = [...rules.forms.values()].find((each) => each.url === url || each.french?.url === url)!;
      const pdf = await PDFDocument.create();
      for (let page = 0; page < form.pages; page += 1) pdf.addPage([612, 792]);
      return pdf.save();
    },
  };
}

describe("the forms on Finish", () => {
  it("are downloaded once the return is finished, saying so while they are prepared", async () => {
    const saved = catchDownloads();
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, true), server: { forms: standIn() } });
    const forms = await screen.findByRole("region", { name: "Your forms" });
    expect(screen.queryByRole("region", { name: "Before you file" })).toBeNull();
    const held = holdRequests((method, path) => method === "GET" && /^\/api\/years\/2025\/returns\/[^/]+\/forms$/.test(path));
    fireEvent.click(within(forms).getByRole("button", { name: "Download the forms (PDF)" }));
    expect(await within(forms).findByText(/Preparing your forms…/)).toBeTruthy();
    expect((within(forms).getByRole("button", { name: /Download the forms|Preparing/ }) as HTMLButtonElement).disabled).toBe(true);
    held.release();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe("Taxi 2025 return - Alex Martin.pdf");
    expect(saved[0]!.blob.type).toBe("application/pdf");
    expect(new TextDecoder().decode((await saved[0]!.blob.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    // The download is handed over before the page says it is done, which it renders a moment later.
    await waitFor(() => expect(within(forms).queryByText(/Preparing your forms…/)).toBeNull());
  });

  it("are downloaded by a viewer too", async () => {
    const saved = catchDownloads();
    await renderApp("/returns/2025/finish", { as: VIEWER, seed: (s) => seed(s, true), server: { forms: standIn() } });
    fireEvent.click(within(await screen.findByRole("region", { name: "Your forms" })).getByRole("button", { name: "Download the forms (PDF)" }));
    await waitFor(() => expect(saved.map((file) => file.name)).toEqual(["Taxi 2025 return - Alex Martin.pdf"]));
  });

  it("say why the forms couldn't be printed", async () => {
    catchDownloads();
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, true), server: { forms: officialForms(() => new Promise<Response>(() => {}), 20) } });
    const forms = await screen.findByRole("region", { name: "Your forms" });
    fireEvent.click(within(forms).getByRole("button", { name: "Download the forms (PDF)" }));
    const banner = (await within(forms).findByText("The forms weren't printed")).closest<HTMLElement>("[role=alert]")!;
    expect(within(banner).getByText("The CRA's form couldn't be downloaded: canada.ca didn't answer in time. Try again later.")).toBeTruthy();
    expect((within(forms).getByRole("button", { name: "Download the forms (PDF)" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("print Revenu Québec's forms in English or French for a resident of Quebec", async () => {
    const source = standIn();
    const saved = catchDownloads();
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, true, { province: "QC" }), server: { forms: source } });
    const forms = await screen.findByRole("region", { name: "Your forms" });
    const choice = within(forms).getByRole("radiogroup", { name: "Revenu Québec's forms in" });
    fireEvent.click(within(choice).getByRole("radio", { name: "Français" }));
    fireEvent.click(within(forms).getByRole("button", { name: "Download the forms (PDF)" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const tp1 = rulesFor(2025)!.forms.get("TP1")!;
    expect(source.fetched).toContain(tp1.french!.url);
    expect(source.fetched).not.toContain(tp1.url);
  });

  it("offer no language choice outside Quebec", async () => {
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, true) });
    const forms = await screen.findByRole("region", { name: "Your forms" });
    expect(within(forms).queryByRole("radiogroup")).toBeNull();
    expect(within(forms).queryByRole("list", { name: "Forms to fill in yourself" })).toBeNull();
  });

  it("name the forms a return needs that aren't printed: Schedule D for a resident of Quebec", async () => {
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, true, { province: "QC" }) });
    const forms = await screen.findByRole("region", { name: "Your forms" });
    const toAdd = within(forms).getByRole("list", { name: "Forms to fill in yourself" });
    expect(within(toAdd).getByText(/^Schedule D, Solidarity Tax Credit \(Revenu Québec\)/)).toBeTruthy();
  });

  it("wait for what is left before filing", async () => {
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, false) });
    const forms = await screen.findByRole("region", { name: "Your forms" });
    expect(within(forms).queryByRole("button", { name: "Download the forms (PDF)" })).toBeNull();
    expect(within(forms).getByText("Finish the items under Before you file, above, to download them.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Before you file" })).getByText("1 slip is not confirmed yet.")).toBeTruthy();
  });

  it("put three or more of your own unanswered questions of a step into one item", async () => {
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, false) });
    const before = await screen.findByRole("region", { name: "Before you file" });
    const items = within(before).getAllByRole("listitem").map((item) => item.textContent ?? "");
    // Your own blockers read "Not answered yet: …"; grouping once matched only the spouse's lower-case wording.
    expect(items.some((text) => /^\d+ questions on (Income|Deductions|Credits) not answered yet: .+ and \d+ more\./.test(text))).toBe(true);
    expect(items.filter((text) => text.startsWith("Not answered yet:")).length).toBeLessThan(3);
  });

  it("wait for the facts about the person, with the way to Personal info", async () => {
    const { router } = await renderApp("/returns/2025/finish", { seed: (s) => seed(s, true, { residentAllYear: null }) });
    const before = await screen.findByRole("region", { name: "Before you file" });
    const item = within(before).getByText("Say whether Alex Martin lived in Canada all year.").closest("li")!;
    expect(within(item).getByRole("link", { name: "Go to the step" }).getAttribute("href")).toBe(router.state.location.pathname.replace(/finish$/, "personal"));
    expect(within(screen.getByRole("region", { name: "Your forms" })).queryByRole("button", { name: "Download the forms (PDF)" })).toBeNull();
  });
});
