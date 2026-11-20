import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hourOf, measureUsage, reportUsage } from "../../src/app/server/lib/usage-metrics.ts";
import { OTHER_ORG, startServer, type TestServer } from "../support/server.ts";

const NOW = Date.UTC(2026, 2, 1, 10, 5);
let server: TestServer;
beforeEach(async () => {
  server = await startServer({ now: () => NOW });
  const alex = (await (await server.call("POST", "/api/people", { body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } })).json()) as { id: string };
  await server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id] } });
  await server.call("POST", "/api/people", { body: { name: "Jamie Martin", relationship: "child", birthDate: "2019-06-20" } });
  await server.call("POST", "/api/people", { as: OTHER_ORG, body: { name: "Olive Other", relationship: "self", birthDate: "1980-01-01" } });
});
afterEach(() => server.close());

describe("the hourly usage report", () => {
  it("counts each organization's records, and nothing else", async () => {
    const report = await measureUsage(server.db, hourOf(NOW), null);
    expect(report.organizations).toEqual([
      { id: "org-a", metrics: { profiles: 1, people: 2, tax_years: 1, returns: 0, documents: 0, storage_bytes: 0 } },
      { id: "org-b", metrics: { profiles: 1, people: 1, tax_years: 0, returns: 0, documents: 0, storage_bytes: 0 } },
    ]);
  });

  it("adds up each organization's stored bytes: its uploaded files and its copies of the official forms", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n% stored\n%%EOF\n");
    const upload = await server.call("POST", "/api/years/2025/documents", {
      raw: pdf as Uint8Array<ArrayBuffer>,
      headers: { "Content-Type": "application/pdf", "X-File-Name": "t4.pdf" },
    });
    expect(upload.status).toBe(200);
    await server.db.prepare("INSERT INTO form_files (org_id, url, sha256, bytes, fetched_at) VALUES (?, ?, ?, ?, 0)").bind("org-a", "https://www.canada.ca/t1.pdf", "x", new Uint8Array(1000)).run();
    const report = await measureUsage(server.db, hourOf(NOW), null);
    expect(report.organizations.find((each) => each.id === "org-a")!.metrics).toMatchObject({ documents: 1, storage_bytes: pdf.byteLength + 1000 });
  });

  it("sends the hour once, with the app's token", async () => {
    const sent: { url: string; auth: string | null; body: unknown }[] = [];
    const env = {
      SUGER_METRICS_URL: "https://insulinapps.example/__insulin/metrics",
      SUGER_APP_TOKEN: "test-token",
      METRICS_FETCH: (async (url: string, init: RequestInit) => {
        sent.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    };
    expect(await reportUsage(server.db, env, NOW)).toBe("sent");
    expect(await reportUsage(server.db, env, NOW + 300_000)).toBe("already_claimed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ auth: "Bearer test-token", body: { hour: "2026-03-01T10:00:00Z", app: { organizations: 2 } } });
    expect(JSON.stringify(sent[0]!.body)).not.toContain("Alex");
  });

  it("releases the hour when the platform refuses, so the next tick tries again", async () => {
    const env = {
      SUGER_METRICS_URL: "https://insulinapps.example/__insulin/metrics",
      SUGER_APP_TOKEN: "test-token",
      METRICS_FETCH: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
    };
    const errors = console.error;
    console.error = () => {};
    try {
      expect(await reportUsage(server.db, env, NOW)).toBe("failed");
    } finally {
      console.error = errors;
    }
    const claims = await server.db.prepare("SELECT count(*) AS n FROM metrics_reports").first<{ n: number }>();
    expect(claims?.n).toBe(0);
  });
});
