import { afterEach, vi } from "vitest";
import { api } from "#shared";

// A fetch stub that answers by route of the API contract. Every mocked body is parsed with the route's own response
// schema: a static body when the mock is installed (the test fails at once), a computed one when it is served (the
// failure is collected and fails the test in afterEach), so a fixture that drifts from the contract can't pass.

export interface MockRequest {
  url: URL;
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

/** A body, or a function of the request that returns one (or a Response), possibly later (a promise). */
type Responder = unknown | ((request: MockRequest) => unknown);

export interface MockHandler {
  route: api.AnyRoute;
  respond: Responder;
}

const violations: string[] = [];

afterEach(() => {
  const found = violations.splice(0);
  if (found.length) throw new Error(`Mocked responses broke the API contract:\n${found.join("\n")}`);
});

function pattern(path: string): { regex: RegExp; names: string[]; params: number } {
  const names: string[] = [];
  const source = path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${source}$`), names, params: names.length };
}

function check(route: api.AnyRoute, body: unknown): string | null {
  if (route.response.kind !== "json") return `${route.id}: only JSON routes can be mocked with a body`;
  const parsed = route.response.schema.safeParse(body);
  return parsed.success ? null : `${route.id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`;
}

/** A JSON error answer whose body passes the contract's error envelope. */
export function apiError(status: number, code: api.ApiErrorCode, message: string, extra: Record<string, unknown> = {}): Response {
  const body = { error: { code, message, ...extra } };
  const parsed = api.apiErrorBodySchema.safeParse(body);
  if (!parsed.success) throw new Error(`Mocked error breaks the envelope: ${JSON.stringify(parsed.error.issues)}`);
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function mock(route: api.AnyRoute, respond: Responder): MockHandler {
  if (typeof respond !== "function" && !(respond instanceof Response)) {
    const problem = check(route, respond);
    if (problem) throw new Error(`Mock breaks the API contract — ${problem}`);
  }
  return { route, respond };
}

export function mockApi(handlers: readonly MockHandler[]) {
  const calls: MockRequest[] = [];
  const compiled = handlers.map((handler) => ({ handler, ...pattern(handler.route.path) })).sort((a, b) => a.params - b.params);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    for (const { handler, regex, names } of compiled) {
      if (handler.route.method !== method) continue;
      const match = regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]));
      let body: unknown = undefined;
      if (typeof init.body === "string") body = JSON.parse(init.body);
      // A multipart upload (the import's files) is kept as sent, for the test to read its fields and files.
      else if (init.body instanceof FormData) body = init.body;
      const request: MockRequest = { url, method, params, query: url.searchParams, headers: new Headers(init.headers), body };
      calls.push(request);
      const result: unknown = await (typeof handler.respond === "function" ? (handler.respond as (request: MockRequest) => unknown)(request) : handler.respond);
      if (result instanceof Response) return result.clone();
      const problem = check(handler.route, result);
      if (problem) violations.push(problem);
      const status = handler.route.response.kind === "json" ? handler.route.response.status : 200;
      return new Response(JSON.stringify(result), { status, headers: { "Content-Type": "application/json" } });
    }
    calls.push({ url, method, params: {}, query: url.searchParams, headers: new Headers(init.headers), body: undefined });
    return apiError(404, "not_found", `No mock for ${method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    /** The requests that matched a route, by route id. */
    callsTo(route: api.AnyRoute) {
      const { regex } = pattern(route.path);
      return calls.filter((call) => call.method === route.method && regex.test(call.url.pathname));
    },
  };
}

/** A response the test releases when it chooses: for request-ordering tests (a lookup that answers late). */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
