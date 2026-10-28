import type { z } from "zod";
import type { ApiErrorBody } from "./errors.ts";
import type { AnyRoute, BodySpec, ResponseSpec } from "./routes.ts";

// The typed client helper: types only. The web app implements `ApiRequest` with fetch (paths from `route.path`, the
// error envelope, a fresh Idempotency-Key per intent); Worker tests can implement it over SELF.fetch.

type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];
/** `{key: T}` when T has a required field, `{key?: T}` when every field may be left out. */
type Slot<Key extends string, T> = [RequiredKeys<T>] extends [never] ? { [K in Key]?: T } : { [K in Key]: T };

type ParamsPart<R extends AnyRoute> = R["params"] extends z.ZodType ? { params: z.input<R["params"]> } : { params?: undefined };

/** Commands with a dry run take `dryRun: true` (sent as `?dryRun=true`) and then a body without the ledger guard. */
type BodyPart<B extends BodySpec> = B extends { kind: "json"; schema: infer S extends z.ZodType; dryRunSchema: infer D }
  ? D extends z.ZodType
    ? { dryRun: true; body: z.input<D> } | ({ dryRun?: false } & Slot<"body", z.input<S>>)
    : Slot<"body", z.input<S>>
  : B extends { kind: "form"; schema: infer S extends z.ZodType }
    ? { body: z.input<S> }
    : B extends { kind: "raw"; headers: infer H extends z.ZodType }
      ? { body: Blob | ArrayBuffer | Uint8Array; headers: z.input<H> }
      : { body?: undefined };

/** A dry-run route's query is only `dryRun`, which BodyPart carries; other routes take their query schema's input. */
type QueryPart<R extends AnyRoute> = R["body"] extends { kind: "json"; dryRunSchema: z.ZodType }
  ? { query?: undefined }
  : R["query"] extends z.ZodType
    ? Slot<"query", z.input<R["query"]>>
    : { query?: undefined };

/**
 * What a call to `route` takes. `idempotencyKey` is the one place an Idempotency-Key comes from, raw uploads included
 * (their `headers` describe the bytes and can't carry one). It is optional because the client mints one per user
 * intent when it is left out; pass the same key again to retry that intent (the API contract).
 */
export type RouteRequest<R extends AnyRoute> = ParamsPart<R> &
  QueryPart<R> &
  BodyPart<R["body"]> & { idempotencyKey?: string; signal?: AbortSignal };

/** What a call to `route` resolves to: the parsed JSON, nothing (204), or the streamed Response of a download. */
export type RouteResult<R extends AnyRoute> = ResultOf<R["response"]>;
type ResultOf<S extends ResponseSpec> = S extends { kind: "json"; schema: infer T extends z.ZodType }
  ? z.output<T>
  : S extends { kind: "empty" }
    ? void
    : S extends { kind: "file" }
      ? Response
      : S extends { kind: "html" | "xml" }
        ? string
        : never; // redirects are browser navigations, not API calls

/** Calls one route. Implementations reject with `ApiFailure` on any non-2xx answer. */
export type ApiRequest = <R extends AnyRoute>(route: R, request: RouteRequest<R>) => Promise<RouteResult<R>>;

export interface ApiClient {
  request: ApiRequest;
}

/** A refused call: the HTTP status and the error envelope (null when the body wasn't one, e.g. a network failure). */
export interface ApiFailure {
  status: number;
  body: ApiErrorBody | null;
}
