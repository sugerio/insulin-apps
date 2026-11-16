import { describe, expect, it } from 'vitest'
import { formatWhenInline, keepReadyLabel, listState, notRestorableReason, stateMessage, supportAddress } from '../../src/app/lib/format.ts'

// The words the screens build from the API's data (design sections 06 and 10).

describe('plain words', () => {
  it('HIS-07 says why a restore point can\'t be brought back, for every reason the engine gives', () => {
    expect(notRestorableReason('removed_for_good')).toMatch(/a file it held was removed for good after it/)
    expect(notRestorableReason('expired')).toMatch(/restore points last 30 days/)
    expect(notRestorableReason('engine_changed')).toMatch(/upgraded/)
    expect(notRestorableReason('newly_hidden')).toMatch(/newer hiding rule/)
    expect(notRestorableReason('damaged')).toMatch(/found damaged when Insulin checked it/)
    expect(notRestorableReason(null)).toBe("This version can't be brought back.")
  })

  it('shows a collection that has learned something but was last heard of as empty as asleep', () => {
    expect(listState({ state: 'empty', documents: 3 })).toBe('asleep')
    expect(listState({ state: 'empty', documents: 0 })).toBe('empty')
    expect(listState({ state: 'ready', documents: 3 })).toBe('ready')
    expect(stateMessage('waking', 'Product FAQ')).toBe('Waking up Product FAQ. This takes about a minute.')
  })

  it('LIM-01 finds the support address in a limit message, and none when the deploy gave none', () => {
    expect(supportAddress('… For a higher limit, contact Insulin Apps support at support@example.test.')).toBe('support@example.test')
    expect(supportAddress('… For a higher limit, contact Insulin Apps support.')).toBeNull()
  })

  it('names keep-ready windows and times inside sentences', () => {
    expect(keepReadyLabel({ days: [1, 2, 3, 4, 5], start: '09:00', hours: 2 })).toBe('09:00–11:00 on working days')
    expect(keepReadyLabel({ days: [6, 0], start: '22:00', hours: 3 })).toBe('22:00–01:00 on Sun, Sat')
    const now = new Date('2026-11-16T15:00:00Z')
    expect(formatWhenInline('2026-11-16T09:16:00Z', now)).toMatch(/^today, /)
  })
})
