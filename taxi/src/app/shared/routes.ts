import { z } from "zod";
import { meSchema, type Permission } from "./access.ts";
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

export const apiCatalogSchema = z.strictObject({
  endpoints: z.array(
    z.strictObject({
      method: z.string(),
      path: z.string(),
      summary: z.string(),
      query: z.null(),
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
