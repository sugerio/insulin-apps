// The managed seal's private key (seal/config.ts). It isn't a string secret the platform's readAppEnv can give: it
// is the Worker's ESIGN_SEAL_KEY binding, a Cloudflare secret_key the runtime hands over as a CryptoKey that can sign
// and can't be exported (put there by scripts/put-seal-key.mjs). Nitro on Workers puts the invocation's env on the
// request (request.runtime.cloudflare.env), as for the gateway binding (gateway-fetch.ts). The deploy never declares
// or overwrites it: `wrangler deploy` keeps a Worker's secret_key bindings, and insulin.secrets doesn't list it.

/** The binding's value, whatever it is; seal/signing.ts isSealSigningKey decides whether it is a usable seal key. */
export function sealKeyOf(request: Request): unknown {
  return (request as Request & { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }).runtime?.cloudflare?.env?.ESIGN_SEAL_KEY
}
