import type { MiddlewareHandler } from "hono";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "font-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  // Sends no Referer off-site but keeps a real Origin on same-origin requests.
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
  // Internal tool: keep every response out of search engines.
  "X-Robots-Tag": "noindex, nofollow",
};

/** Applies the security headers to every response, static assets included. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    for (const [name, value] of Object.entries(HEADERS)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    if (new URL(c.req.url).protocol === "https:") {
      headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    }
    const path = c.req.path;
    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      headers.set("Cache-Control", "no-store");
    }
  };
}
