import "./setup.ts";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { companyKey, setupRequest, validateSetup } from "../../src/app/pages/SetupPage.tsx";

// The first-run company setup's pure parts: the internal key derived from the name, the checks, and the request.

const VALUES = { displayName: "Acme Robotics", legalName: "", jurisdiction: "US-DE", incorporationDate: "", timezone: "America/Los_Angeles", fiscalYearEnd: "12-31" };

describe("company setup", () => {
  it("derives a key the contract accepts from any company name", () => {
    expect(companyKey("Acme Robotics")).toBe("acme-robotics");
    expect(companyKey("  Société Générale (US), Inc.  ")).toBe("societe-generale-us-inc");
    expect(companyKey("株式会社")).toBe("company-1");
    expect(companyKey("X")).toBe("company-x");
    expect(companyKey("A".repeat(60))).toHaveLength(40);
    for (const name of ["Acme Robotics", "株式会社", "X", "---", "A".repeat(60), "Beta & Co. — Fabrication"]) {
      expect(api.orgKeySchema.safeParse(companyKey(name)).success).toBe(true);
    }
  });

  it("asks for a name and a time zone, and checks the optional date", () => {
    expect(validateSetup(VALUES)).toEqual({});
    expect(validateSetup({ ...VALUES, displayName: " ", timezone: "" })).toEqual({ displayName: "Enter the company name.", timezone: "Choose the company's time zone." });
    expect(validateSetup({ ...VALUES, incorporationDate: "21/02/2021" })).toEqual({ incorporationDate: "Enter a date." });
  });

  it("sends what the form says, the legal name defaulting to the company name, as the contract expects", () => {
    const request = setupRequest({ ...VALUES, incorporationDate: "2021-02-15" });
    expect(request).toEqual({
      orgKey: "acme-robotics", displayName: "Acme Robotics", legalName: "Acme Robotics", jurisdiction: "US-DE", timezone: "America/Los_Angeles",
      fiscalYearEnd: "12-31", incorporationDate: "2021-02-15",
    });
    expect(api.createOrgRequestSchema.safeParse(request).success).toBe(true);
  });
});
