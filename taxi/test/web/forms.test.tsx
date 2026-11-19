import "./setup.ts";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Estimate, Person, TaxYear } from "#shared";
import { OWNER, type TestServer } from "../support/server.ts";
import { renderApp } from "./support.tsx";

/** Alex, single in Ontario, with a T4; `finished` answers what the return assumes and confirms the slip. */
async function seed(server: TestServer, finished: boolean): Promise<void> {
  const call = async <T,>(method: string, path: string, body: unknown) => (await (await server.call(method, path, { as: OWNER, body })).json()) as T;
  const alex = await call<Person>("POST", "/api/people", { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" });
  await call("POST", "/api/years", { year: 2025, people: [alex.id] });
  let year = await call<TaxYear>("PUT", "/api/years/2025/household", { revision: 1, maritalStatus: "single", adults: [{ personId: alex.id, province: "ON", residentAllYear: true }] });
  year = await call<TaxYear>("POST", "/api/years/2025/slips", { revision: year.revision, personId: alex.id, type: "T4", issuer: "Maple Corp", boxes: { 14: "60000", 22: "9000" } });
  if (!finished) return;
  const estimate = (await (await server.call("GET", "/api/years/2025/estimate", { as: OWNER })).json()) as Estimate;
  const answers = Object.fromEntries(estimate.result.people[0]!.estimates.map((item) => [item.question, item.assumed]));
  year = await call<TaxYear>("PUT", "/api/years/2025/answers", { revision: year.revision, personId: alex.id, answers });
  await call("POST", "/api/years/2025/slips/confirm", { revision: year.revision, personId: alex.id });
}

describe("the forms on Finish", () => {
  it("can be downloaded once the return is finished", async () => {
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, true) });
    const forms = await screen.findByRole("region", { name: "Your forms" });
    const link = within(forms).getByRole("link", { name: "Download the forms (PDF)" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toMatch(/^\/api\/years\/2025\/returns\/[0-9a-f-]+\/forms$/);
    expect(screen.queryByRole("region", { name: "Before you file" })).toBeNull();
  });

  it("wait for what is left before filing", async () => {
    await renderApp("/returns/2025/finish", { seed: (s) => seed(s, false) });
    const forms = await screen.findByRole("region", { name: "Your forms" });
    expect(within(forms).queryByRole("link")).toBeNull();
    expect(within(forms).getByText("Finish the items under Before you file, above, to download them.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Before you file" })).getByText("1 slip is not confirmed yet.")).toBeTruthy();
  });
});
