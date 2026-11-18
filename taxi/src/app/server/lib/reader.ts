import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { RuleSet } from "../../shared/engine/rules.ts";

// Reading a tax slip with Claude: one Messages API call per uploaded file, answering in one JSON shape (structured
// output), so there is no free text to parse. The prompt is built from the year's slip types (slips.yaml), so it
// follows the rule files. The server checks the answer again before anything is saved (documents.ts).

export const READER_MODEL = "claude-opus-5-5";

export interface FileToRead {
  bytes: Uint8Array;
  contentType: "application/pdf" | "image/png" | "image/jpeg";
}

export interface ReadContext {
  year: number;
  rules: RuleSet;
  /** The household's people, so the model can say whose slip it is. */
  people: { name: string; relationship: string }[];
}

export interface ReadSlip {
  type: string;
  /** The name on the slip, as printed. */
  person: string;
  issuer: string;
  /** Box number → amount as printed (no $ or commas). */
  boxes: Record<string, string>;
  unsure: string[];
}

export type ReadOutcome =
  | { kind: "read"; taxYear: number | null; slips: ReadSlip[]; model: string }
  | { kind: "not_available"; message: string }
  | { kind: "failed"; message: string };

export interface SlipReader {
  read(file: FileToRead, context: ReadContext): Promise<ReadOutcome>;
}

/** The answer's shape, for the API (`output_config.format`) and for checking what came back. */
const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taxYear", "slips"],
  properties: {
    taxYear: { type: ["integer", "null"], description: "The tax year printed on the slips, or null." },
    slips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "person", "issuer", "boxes", "unsure"],
        properties: {
          type: { type: "string" },
          person: { type: "string" },
          issuer: { type: "string" },
          boxes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["box", "amount"],
              properties: { box: { type: "string" }, amount: { type: "string" } },
            },
          },
          unsure: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const answerSchema = z.object({
  taxYear: z.number().int().nullable(),
  slips: z.array(
    z.object({
      type: z.string(),
      person: z.string(),
      issuer: z.string(),
      boxes: z.array(z.object({ box: z.string(), amount: z.string() })),
      unsure: z.array(z.string()),
    }),
  ),
});

/** The instructions for one file: the year, the household's names, and each slip type with its boxes. */
export function promptFor(context: ReadContext): string {
  const types = [...context.rules.slips.values()].map(
    (slip) =>
      `- ${slip.id}, ${slip.title}: ${slip.about}. Boxes: ${Object.entries(slip.boxes)
        .map(([box, label]) => `${box} (${label})`)
        .join(", ")}.`,
  );
  return [
    `You read Canadian personal tax slips for the ${context.year} tax year.`,
    `The household: ${context.people.map((person) => `${person.name} (${person.relationship})`).join(", ")}.`,
    "Slip types this app reads:",
    ...types,
    "",
    "Return every slip in this file. A file may hold one slip, or several (for example one per page); if the same slip appears more than once, as copies do, return it once.",
    "For each slip:",
    "- type: one of the slip types above.",
    "- person: the recipient's or student's name as printed on the slip.",
    "- issuer: who issued the slip (the employer, payer, trust, broker or institution).",
    "- boxes: each box from that type's list that shows an amount, with the amount exactly as printed but without $ signs, spaces or thousands separators (for example 60000.00). Leave out empty boxes and boxes not in the list. Copy amounts; never add them up.",
    "- unsure: the numbers of any boxes you could not read clearly.",
    "taxYear: the tax year printed on the slips, or null if none is printed.",
    "Never return a social insurance number. If the file holds none of these slip types (a receipt, a letter, another form), return no slips.",
  ].join("\n");
}

/** Reads with a Claude client: through the platform's integration proxy, or directly in local development. */
export function claudeReader(client: Anthropic): SlipReader {
  return {
    async read(file, context) {
      const data = toBase64(file.bytes);
      const source =
        file.contentType === "application/pdf"
          ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } } as const)
          : ({ type: "image", source: { type: "base64", media_type: file.contentType, data } } as const);
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create({
          model: READER_MODEL,
          max_tokens: 16000,
          // A declined request is re-run on a fallback model chosen by the API, instead of failing the upload.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
          messages: [{ role: "user", content: [source, { type: "text", text: promptFor(context) }] }],
        });
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
          return { kind: "not_available", message: "The organization's Anthropic credential was refused. An admin can check it under Settings › Integrations." };
        }
        if (error instanceof Anthropic.RateLimitError) return { kind: "failed", message: "Too many files are being read right now. Try this one again in a minute." };
        if (error instanceof Anthropic.APIError) return { kind: "failed", message: `Reading this file failed (${error.status ?? "no answer"}). Try again.` };
        throw error;
      }
      if (response.stop_reason === "refusal") return { kind: "failed", message: "This file couldn't be read." };
      if (response.stop_reason === "max_tokens") return { kind: "failed", message: "This file is too long to read at once. Upload its pages separately." };
      const text = response.content.find((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")?.text;
      let answer: z.infer<typeof answerSchema>;
      try {
        answer = answerSchema.parse(JSON.parse(text ?? ""));
      } catch {
        return { kind: "failed", message: "Reading this file went wrong. Try again." };
      }
      return {
        kind: "read",
        taxYear: answer.taxYear,
        model: response.model,
        slips: answer.slips.map((slip) => ({
          type: slip.type,
          person: slip.person,
          issuer: slip.issuer,
          boxes: Object.fromEntries(slip.boxes.map((box) => [box.box, box.amount])),
          unsure: slip.unsure,
        })),
      };
    },
  };
}

/** A reader for where AI reading isn't set up: every file says why. */
export function unavailableReader(message: string): SlipReader {
  return { read: async () => ({ kind: "not_available", message }) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
