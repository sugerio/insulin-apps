// R2 calls that ride over R2's own transient refusals. R2 appends its error code to the message, in parentheses
// ("head: Reduce your rate of simultaneous reads on the same object. (10058)"); its documented codes for a request
// worth trying again (r2/api/error-codes) are 10001 InternalError, 10043 ServiceUnavailable (with exponential backoff)
// and 10058 TooManyRequests (too many requests at once on the same key). Anything else fails at once.

import { clock, errorText } from './util.ts'

const TRANSIENT = /\((?:10001|10043|10058)\)\s*$/

/** Waits before each new try of an R2 call refused for a transient reason: four more over about 7.5 seconds. */
const WAITS_MS = [500, 1_000, 2_000, 4_000]

export const transientR2 = (error: unknown): boolean => TRANSIENT.test(errorText(error))

export async function r2<T>(call: () => Promise<T>): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await call()
    } catch (error) {
      if (!transientR2(error) || tries >= WAITS_MS.length) throw error
      await clock.wait(WAITS_MS[tries])
    }
  }
}
