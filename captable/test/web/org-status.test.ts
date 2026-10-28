import "./setup.ts";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/app/api/client.ts";
import { describeError } from "../../src/app/lib/errors.ts";
import { orgWriteRestriction } from "../../src/app/lib/org.ts";

describe("company write restrictions", () => {
  it("accepts writes in an active company", () => {
    expect(orgWriteRestriction("active")).toBeNull();
  });

  it("refuses writes in a company that isn't active, in plain words", () => {
    expect(orgWriteRestriction("paused")).toEqual({ title: "Changes unavailable", text: "This company can't be changed right now." });
  });

  it("keeps the server's inactive-company copy, and says plainly when the console no longer vouches for the caller", () => {
    const message = "This organization can't be changed right now.";
    expect(describeError(new ApiError(403, "forbidden", message, "org_inactive"))).toBe(message);
    expect(describeError(new ApiError(403, "forbidden", "", "org_inactive"))).toBe("This company can't be changed right now.");
    expect(describeError(new ApiError(401, "unauthenticated", "No console identity"))).toBe("Open this app from the Insulin console to continue.");
    expect(describeError(new ApiError(0, "network_error", "offline"))).toBe("Couldn't reach Cap Table. Check your connection and try again.");
  });
});
