// The tick's deadline, carried into the calls it makes (the engine, the platform): a call that answers late, or sends
// its body slowly, is given up at the deadline, so the tick always ends within its time.

/**
 * Waits for `work` until `deadline` (Date.now() time), and gives up then: a call the tick makes never holds it past its
 * time, whether the engine is slow to answer or to send the body. Without a deadline it simply waits.
 */
export async function beforeDeadline<T>(work: Promise<T>, deadline: number | undefined, what = 'The call'): Promise<T> {
  if (deadline === undefined) return work
  // Given up, the work may still fail later: that is no longer anyone's to handle.
  work.catch(() => undefined)
  const left = deadline - Date.now()
  if (left <= 0) throw new DeadlinePassed(what)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlinePassed(what)), left) })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** A call given up at its deadline. */
export class DeadlinePassed extends Error {
  override name = 'DeadlinePassed'
  constructor(what: string) {
    super(`${what} ran out of time`)
  }
}
