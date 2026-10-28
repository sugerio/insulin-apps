import "./setup.ts";
import { describe, expect, it, vi } from "vitest";
import { onUnauthorized } from "../../src/app/api/client.ts";
import { getMe } from "../../src/app/auth/AuthProvider.tsx";
import { me } from "./support/acme.ts";

// /api/me is the console identity: the user, their console role, what it lets them do here, and the company.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("/api/me", () => {
  it("loads the console identity with the shape the app reads", async () => {
    const fetch = vi.fn().mockResolvedValue(json(me("admin_rw")));
    vi.stubGlobal("fetch", fetch);
    const answer = await getMe();
    expect(answer).toMatchObject({ consoleRole: "ADMIN", access: "admin_rw", preview: false, company: { displayName: "Acme Robotics" } });
    expect(fetch).toHaveBeenCalledWith("/api/me", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });

  it("refuses an answer that isn't the console identity's shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ user: { id: "u" }, superAdmin: true, orgs: [] })));
    await expect(getMe()).rejects.toMatchObject({ code: "internal" });
  });

  it("maps structured API and network errors", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "forbidden", message: "No access" } }, 403))
      .mockRejectedValueOnce(new Error("offline")));
    await expect(getMe()).rejects.toMatchObject({ status: 403, code: "forbidden", message: "No access" });
    await expect(getMe()).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("reports a 401 to every listener until it unsubscribes", async () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { code: "unauthenticated", message: "No console identity" } }, 401)));
    await expect(getMe()).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await expect(getMe()).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledOnce();
  });
});
