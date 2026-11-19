// Work that may outlive the response. Nitro on Workers attaches the invocation's waitUntil to the request it passes on
// (srvx does in the local preview, when it has one); without one, the caller does the work in the request.

/** The request's waitUntil, bound to it, when the runtime attached one. */
export function waitUntilOf(request: Request): ((work: Promise<unknown>) => void) | undefined {
  const waitUntil = (request as Request & { waitUntil?: unknown }).waitUntil
  return typeof waitUntil === 'function' ? (work) => { (waitUntil as (work: Promise<unknown>) => void).call(request, work) } : undefined
}
