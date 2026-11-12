import { openAppD1, readAppEnv } from '#platform'
import app, { type Bindings } from './esign/app.ts'
import { D1BlobStore } from './esign/blob-store.ts'
import { SEAL_KEYS } from './esign/seal/keys.ts'
import { gatewayFetchOf } from './gateway-fetch.ts'
import { sealKeyOf } from './seal-key-binding.ts'
import { waitUntilOf } from './wait-until.ts'

// The local preview runs without the deployment's secrets: these synthetic keys let it sign and seal
// with the HMAC test seal. They are never used published (ESIGN_ENV is prod there, and prod needs
// the real ESIGN_OTP_KEY and the managed seal).
const PREVIEW_OTP_KEY = 'local-preview-otp-pepper-not-for-real-documents'
const PREVIEW_SEAL_KEY = 'local-preview-hmac-seal-key-not-for-real-documents'

/** What Esign runs with, from the platform: the D1 binding, the ESIGN_* secrets, the seal key and the mail relay. */
async function bindings(request: Request): Promise<Bindings> {
  const db = (await openAppD1()) as unknown as D1Database
  const dev = import.meta.env.DEV && readAppEnv('SUGER_ACCESS_MODE') !== 'console'
  const secret = (name: string) => readAppEnv(name)?.trim() || undefined
  const gatewayFetch = gatewayFetchOf(request)
  return {
    DB: db,
    ARTIFACTS: new D1BlobStore(db, 'artifacts'),
    ...(dev ? { TEST_MAIL: new D1BlobStore(db, 'test-mail') } : {}),
    ESIGN_ENV: dev ? 'dev' : 'prod',
    IDENTITY_PREVIEW: dev,
    COMPLETE_AFTER_SIGN: 'true',
    // Nitro on Workers puts the invocation's waitUntil on the request (srvx does in the local preview, when it has one).
    WAIT_UNTIL: waitUntilOf(request),
    APP_ORIGIN: new URL(request.url).origin,
    OTP_KEY: secret('ESIGN_OTP_KEY') ?? (dev ? PREVIEW_OTP_KEY : undefined),
    TEST_SEAL_KEY: dev ? PREVIEW_SEAL_KEY : undefined,
    SIGNING_PAGE_FRAME_ANCESTORS: secret('ESIGN_FRAME_ANCESTORS'),
    // The managed seal: the Worker's seal key binding, never in the local preview, and the keys
    // this code trusts (seal/keys.ts), never the deployment's configuration.
    SEAL_KEY: dev ? undefined : sealKeyOf(request),
    SEAL_KEYS,
    SUGER_MAIL_URL: secret('SUGER_MAIL_URL'),
    SUGER_APP_TOKEN: secret('SUGER_APP_TOKEN'),
    // The relay is called through the gateway's service binding when the deploy gave the app one (gateway-fetch.ts).
    ...(gatewayFetch ? { MAIL_FETCH: gatewayFetch } : {}),
  }
}

/** Every `/api/**` request of the app (src/api.ts): Esign's Hono app, with the platform's bindings. */
export async function handleAppRequest(request: Request): Promise<Response> {
  return app.fetch(request, await bindings(request))
}
