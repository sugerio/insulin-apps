// A new version of Esign deployed while a member's page is open: the page goes on with the code it loaded, whose
// lazily loaded parts (PDF.js for a template's document) the new version no longer has. Loading one then fails; the
// page reloads once to take the new version, and says so if that didn't help. Only the members' pages do this: the
// signing page and the field editor open with a one-time code, which a reload would spend.

/** A part of the app that couldn't be loaded: most likely, the version the page runs was replaced. */
export class StaleVersion extends Error {
  constructor() { super('A part of Esign could not be loaded') }
}

/** Loads a lazily loaded part of the app; a failure is a StaleVersion. */
export async function loadPart<T>(load: () => Promise<T>): Promise<T> {
  try { return await load() } catch { throw new StaleVersion() }
}

const KEY = 'esign-reloaded-for-update'
/** Reloads the page to take the new version, unless it did so in the last minute (a loop). Whether it reloads. */
export function reloadForUpdate(now = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(KEY))
    if (last && now - last < 60_000) return false
    window.sessionStorage.setItem(KEY, String(now))
    window.location.reload()
    return true
  } catch { return false }
}
