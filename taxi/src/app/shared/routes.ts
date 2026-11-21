import { z } from "zod";
import { meSchema, type Permission } from "./access.ts";
import { documentListSchema, readResultSchema } from "./documents.ts";
import { estimateSchema } from "./estimate.ts";
import { decideHintSchema, hintListSchema, hintParamsSchema } from "./hints.ts";
import { confirmSlipsSchema, createSlipSchema, revisionBodySchema, saveAnswersSchema, slipListSchema, updateSlipSchema } from "./returns.ts";
import {
  createPersonSchema,
  idSchema,
  peopleListSchema,
  personSchema,
  saveHouseholdSchema,
  setYearPeopleSchema,
  startYearSchema,
  taxYearSchema,
  updatePersonSchema,
  yearListSchema,
  yearSchema,
} from "./household.ts";

// The API's route table: the server mounts these paths, the browser calls them through `apiRequest`, and
// `GET /api/catalog` publishes them for AI agents and API clients (AGENTS.md, "Publish your API"). The platform's tick
// (`POST /api/scheduled`) and `GET /api/health` are not in it.

export interface Route<
  Params extends z.ZodType | null = z.ZodType | null,
  Body extends z.ZodType | null = z.ZodType | null,
  Response extends z.ZodType | null = z.ZodType | null,
> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  /** The permission the caller needs; null for any identified caller. */
  permission: Permission | null;
  params: Params;
  body: Body;
  /** The answer's schema; null for 204 No Content. */
  response: Response;
}

const route = <P extends z.ZodType | null, B extends z.ZodType | null, R extends z.ZodType | null>(spec: Route<P, B, R>) => spec;

const yearParams = z.strictObject({ year: yearSchema });
const personParams = z.strictObject({ id: idSchema });
const slipParams = z.strictObject({ year: yearSchema, id: idSchema });
const documentParams = z.strictObject({ year: yearSchema, id: idSchema });

export const apiCatalogSchema = z.strictObject({
  endpoints: z.array(
    z.strictObject({
      method: z.string(),
      path: z.string(),
      summary: z.string(),
      query: z.record(z.string(), z.unknown()).nullable(),
      body: z.record(z.string(), z.unknown()).nullable(),
      idempotencyKey: z.boolean(),
    }),
  ),
});
export type ApiCatalog = z.infer<typeof apiCatalogSchema>;

export const routes = {
  getMe: route({
    method: "GET",
    path: "/api/me",
    summary: "Who is calling: their role and permissions here.",
    permission: null,
    params: null,
    body: null,
    response: meSchema,
  }),
  getCatalog: route({
    method: "GET",
    path: "/api/catalog",
    summary: "The endpoints the caller may use, with their request bodies as JSON Schema.",
    permission: null,
    params: null,
    body: null,
    response: apiCatalogSchema,
  }),
  listYears: route({
    method: "GET",
    path: "/api/years",
    summary: "The household's people and tax years, with each year's progress.",
    permission: "taxi.view",
    params: null,
    body: null,
    response: yearListSchema,
  }),
  startYear: route({
    method: "POST",
    path: "/api/years",
    summary:
      "Start a tax year (only supported years) with the people in it: you, your spouse to prepare both returns together, and the dependants who lived with you. Starting one that exists returns it unchanged.",
    permission: "taxi.prepare",
    params: null,
    body: startYearSchema,
    response: taxYearSchema,
  }),
  getYear: route({
    method: "GET",
    path: "/api/years/:year",
    summary: "A tax year: who is in it, the marital status, each adult's province and residency, and open issues.",
    permission: "taxi.view",
    params: yearParams,
    body: null,
    response: taxYearSchema,
  }),
  getEstimate: route({
    method: "GET",
    path: "/api/years/:year/estimate",
    summary:
      "What the tax engine computes for each return of the year from what is entered so far: the result lines, each one complete, estimated or missing, and the engine input to explain them.",
    permission: "taxi.view",
    params: yearParams,
    body: null,
    response: estimateSchema,
  }),
  listHints: route({
    method: "GET",
    path: "/api/years/:year/hints",
    summary:
      "Checks on each return of the year, like a tax program's check and optimize: savings worked out with and without a change of answers (effect is what the household's refund less balance owing goes up by), and things to know. Each has a state: open, applied (an accepted saving) or dismissed.",
    permission: "taxi.view",
    params: yearParams,
    body: null,
    response: hintListSchema,
  }),
  decideHint: route({
    method: "POST",
    path: "/api/years/:year/hints/:hint",
    summary:
      "Decide on a hint of an adult's return: accept a saving (its answers are saved, and the answers it changed are kept to undo it), dismiss a hint, or undo either. Send the revision you read.",
    permission: "taxi.prepare",
    params: hintParamsSchema,
    body: decideHintSchema,
    response: taxYearSchema,
  }),
  setYearPeople: route({
    method: "PUT",
    path: "/api/years/:year/people",
    summary:
      "Change who is in a tax year. Including your spouse prepares both returns together. Send the revision you read; a stale one is refused with 409.",
    permission: "taxi.prepare",
    params: yearParams,
    body: setYearPeopleSchema,
    response: taxYearSchema,
  }),
  saveHousehold: route({
    method: "PUT",
    path: "/api/years/:year/household",
    summary:
      "Save the year's facts: marital status on December 31, and each adult's province and residency. Send the revision you read; a stale one is refused with 409.",
    permission: "taxi.prepare",
    params: yearParams,
    body: saveHouseholdSchema,
    response: taxYearSchema,
  }),
  listDocuments: route({
    method: "GET",
    path: "/api/years/:year/documents",
    summary: "The files uploaded for the year, newest first, with what reading each one found.",
    permission: "taxi.view",
    params: yearParams,
    body: null,
    response: documentListSchema,
  }),
  uploadDocument: route({
    method: "POST",
    path: "/api/years/:year/documents",
    summary:
      "Upload one file (PDF, PNG or JPEG, up to 10 MiB) for AI to read into slips: send its bytes as the body with its Content-Type, its name in an X-File-Name header (URI-encoded; required, as a file replaces the one of the same name in the return), and the adult whose return it is uploaded in as an X-Person-Id header (the person preparing without it). Slips found are added unconfirmed to the adult whose name is on them. A slip naming someone else in the year, who has no return here (a child), isn't added, but a receipt for them (such as a medical receipt) goes to this adult; a slip whose name matches no one in the year, or several, goes to this adult, marked to check whose it is. A file with the name of one in the same return, changed or not, replaces it and its slips once read into slips (listed in replaced); if it can't be, the earlier one is kept. Otherwise the same file under another name, or the same slips, already in the year are not saved again, even when uploaded at the same time (status duplicate). An upload that fails part-way changes nothing.",
    permission: "taxi.prepare",
    params: yearParams,
    body: null,
    response: readResultSchema,
  }),
  readDocumentAgain: route({
    method: "POST",
    path: "/api/years/:year/documents/:id/read",
    summary:
      "Read a file again that couldn't be read (status failed or not_available), from the bytes already stored. Its slips are added as for an upload; a file whose slips are already in the year is removed (status duplicate).",
    permission: "taxi.prepare",
    params: documentParams,
    body: null,
    response: readResultSchema,
  }),
  deleteDocument: route({
    method: "DELETE",
    path: "/api/years/:year/documents/:id",
    summary:
      "Delete an uploaded file and every slip read from it, confirmed or not, in whichever adult's return it is. Send the revision you read.",
    permission: "taxi.prepare",
    params: documentParams,
    body: revisionBodySchema,
    response: taxYearSchema,
  }),
  saveAnswers: route({
    method: "PUT",
    path: "/api/years/:year/answers",
    summary:
      "Save an adult's answers to the year's questions: {question: value}, money as decimal text, yes/no as true/false, null to clear. The questions are in GET /api/years/{year}/estimate. Send the revision you read.",
    permission: "taxi.prepare",
    params: yearParams,
    body: saveAnswersSchema,
    response: taxYearSchema,
  }),
  listSlips: route({
    method: "GET",
    path: "/api/years/:year/slips",
    summary: "Every slip of the year's adults: type, issuer, boxes as printed, and whether it was confirmed against the paper slip.",
    permission: "taxi.view",
    params: yearParams,
    body: null,
    response: slipListSchema,
  }),
  addSlip: route({
    method: "POST",
    path: "/api/years/:year/slips",
    summary: "Add a slip for an adult of the year: its type (T4, T5, T3, T5008, T2202), issuer and boxes as printed. It starts unconfirmed.",
    permission: "taxi.prepare",
    params: yearParams,
    body: createSlipSchema,
    response: taxYearSchema,
  }),
  updateSlip: route({
    method: "PATCH",
    path: "/api/years/:year/slips/:id",
    summary:
      "Change a slip's issuer or boxes (boxes replaces them all). The slip goes back to unconfirmed. A box AI wasn't sure of is no longer marked once it is in boxes; one AI couldn't read stays marked until it is (0 if it is blank on the slip).",
    permission: "taxi.prepare",
    params: slipParams,
    body: updateSlipSchema,
    response: taxYearSchema,
  }),
  removeSlip: route({
    method: "DELETE",
    path: "/api/years/:year/slips/:id",
    summary: "Remove a slip. Send the revision you read.",
    permission: "taxi.prepare",
    params: slipParams,
    body: revisionBodySchema,
    response: taxYearSchema,
  }),
  confirmSlips: route({
    method: "POST",
    path: "/api/years/:year/slips/confirm",
    summary:
      "Confirm the unconfirmed slips of one adult (personId), or of every adult without it: someone checked each one against the paper slip. Refused with 400, naming each box, while a slip has a box AI couldn't read and no amount: enter it first (0 if it is blank on the slip).",
    permission: "taxi.prepare",
    params: yearParams,
    body: confirmSlipsSchema,
    response: taxYearSchema,
  }),
  listPeople: route({
    method: "GET",
    path: "/api/people",
    summary: "Everyone in the household, the same every year.",
    permission: "taxi.view",
    params: null,
    body: null,
    response: peopleListSchema,
  }),
  addPerson: route({
    method: "POST",
    path: "/api/people",
    summary: "Add a person to the household: you (once), a spouse or common-law partner (once), a child or another dependant.",
    permission: "taxi.prepare",
    params: null,
    body: createPersonSchema,
    response: personSchema,
  }),
  updatePerson: route({
    method: "PATCH",
    path: "/api/people/:id",
    summary: "Change a person's name, relationship or birth date.",
    permission: "taxi.prepare",
    params: personParams,
    body: updatePersonSchema,
    response: personSchema,
  }),
  removePerson: route({
    method: "DELETE",
    path: "/api/people/:id",
    summary: "Remove a person from the household, with their facts in every tax year. You can't remove yourself.",
    permission: "taxi.prepare",
    params: personParams,
    body: null,
    response: null,
  }),
} as const;

export type Routes = typeof routes;
export type AnyRoute = Routes[keyof Routes];
export const ROUTE_TABLE: readonly AnyRoute[] = Object.values(routes);

/** An endpoint that answers with a file, not JSON: served apart from the route table, and in the catalog with it. */
export interface FileRoute {
  method: "GET";
  path: string;
  summary: string;
  permission: Permission;
  /** Its query parameters, as JSON Schema; null for none. */
  query: Record<string, unknown> | null;
}

export const fileRoutes = {
  documentFile: {
    method: "GET",
    path: "/api/years/:year/documents/:id/file",
    summary: "An uploaded file's bytes as stored: the PDF, PNG or JPEG itself, with its Content-Type, to look at beside the slips read from it.",
    permission: "taxi.view",
    query: null,
  },
  returnForms: {
    method: "GET",
    path: "/api/years/:year/returns/:personId/forms",
    summary:
      "A finished return as a PDF (application/pdf): the CRA's T1 and provincial form with the amounts filled in, then a worksheet. Refused with 409 while anything is left before filing (the message says what), and with 503 when canada.ca doesn't answer or its form changed.",
    permission: "taxi.view",
    query: {
      type: "object",
      properties: { download: { type: "string", description: "Set (download=1) to get the PDF as an attachment to save; without it, it opens inline." } },
      additionalProperties: false,
    },
  },
} as const satisfies Record<string, FileRoute>;
