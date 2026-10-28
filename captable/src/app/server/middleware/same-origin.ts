import type { MiddlewareHandler } from "hono";
import { forbidden } from "../lib/http.ts";
import type { AppEnv } from "../types.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for state-changing requests: the Origin must be this app and,
 * when the browser reports it, the request must be same-origin.
 */
export function requireSameOrigin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("Origin");
      const site = c.req.header("Sec-Fetch-Site");
      if (origin !== c.get("config").origin || (site !== undefined && site !== "same-origin")) {
        throw forbidden("Cross-site request blocked");
      }
    }
    await next();
  };
}
