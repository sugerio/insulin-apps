import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { READER_MODEL, claudeReader, promptFor, type ReadContext } from "../../src/app/server/lib/reader.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

const context: ReadContext = { year: 2025, rules: rulesFor("ca", 2025)!, people: [{ name: "Alex Martin", relationship: "self" }] };
const file = { bytes: new TextEncoder().encode("%PDF-1.4 sample"), contentType: "application/pdf" as const };

/** A client whose requests are captured and answered with `reply`, as the API would. */
function stubbed(reply: object) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const client = new Anthropic({
    apiKey: "added-by-insulin-apps",
    baseURL: "https://api.anthropic.com",
    defaultHeaders: { "x-suger-organization-id": "org-1" },
    maxRetries: 0,
    fetch: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: READER_MODEL, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 }, ...reply }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { client, requests };
}

const answer = (json: object) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(json) }] });

describe("reading a slip with Claude", () => {
  it("sends the file as a document with the prompt, and asks for the answer's JSON shape", async () => {
    const { client, requests } = stubbed(answer({ taxYear: 2025, slips: [{ type: "T4", person: "Alex Martin", issuer: "Maple Corp", boxes: [{ box: "14", amount: "60000.00" }], unsure: [] }] }));
    const outcome = await claudeReader(client).read(file, context);
    expect(outcome).toEqual({ kind: "read", taxYear: 2025, model: READER_MODEL, slips: [{ type: "T4", person: "Alex Martin", issuer: "Maple Corp", boxes: { 14: "60000.00" }, unsure: [] }] });
    const [request] = requests;
    expect(request!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(request!.headers.get("x-suger-organization-id")).toBe("org-1");
    expect(request!.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema" } } });
    const content = (request!.body.messages as { content: { type: string; source?: { media_type: string } }[] }[])[0]!.content;
    expect(content.map((block) => block.type)).toEqual(["document", "text"]);
    expect(content[0]!.source!.media_type).toBe("application/pdf");
  });

  it("keys a Quebec RL slip's boxes as the rules name them", async () => {
    // Box B.A of an RL-1 is B_A in slips.yaml, so a formula can name it; a box read as printed lands there.
    const boxes = [
      { box: "A", amount: "62000.00" },
      { box: "B.A", amount: "3744.00" },
      { box: "201", amount: "500.00" },
    ];
    const { client } = stubbed(answer({ taxYear: 2025, slips: [{ type: "RL1", person: "Alex Martin", issuer: "Maple Corp", boxes, unsure: ["B.A"] }] }));
    const outcome = await claudeReader(client).read(file, context);
    expect(outcome).toMatchObject({ kind: "read", slips: [{ type: "RL1", boxes: { A: "62000.00", B_A: "3744.00", 201: "500.00" }, unsure: ["B_A"] }] });
  });

  it("says why when the model declines or answers in another shape", async () => {
    expect(await claudeReader(stubbed({ stop_reason: "refusal", content: [] }).client).read(file, context)).toEqual({ kind: "failed", message: "This file couldn't be read." });
    expect(await claudeReader(stubbed(answer({ nope: true })).client).read(file, context)).toEqual({ kind: "failed", message: "Reading this file went wrong. Try again." });
  });

  it("builds the prompt from the year's slip types and the people", () => {
    const prompt = promptFor(context);
    expect(prompt).toContain("for the 2025 tax year");
    expect(prompt).toContain("Alex Martin (self)");
    expect(prompt).toContain("- T2202, T2202 Tuition and Enrolment Certificate");
    expect(prompt).toContain("16A (Employee's second CPP contributions)");
    expect(prompt).toContain("Never return a social insurance number.");
    expect(prompt).toContain("- RL1, RL-1 slip, Employment and Other Income (Revenu Québec)");
    expect(prompt).toContain("B_A (QPP contribution (box B.A))");
  });
});
