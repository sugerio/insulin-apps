import { describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { addDocument, getJson, ledgerHarness, runCommand, type LedgerHarness } from '../support/ledger-helpers.ts'

/**
 * What the admin write UI codes against, settled by the contract and the handlers: the exercise's lots and portions
 * derived by the server for the exercise date, dry runs without a typed confirmation, the valuation event's typed
 * confirmation, and the last reversible command of a lot.
 */

async function exerciseBody(l: LedgerHarness, extra: Record<string, unknown> = {}) {
  return {
    securityId: l.id('OPT-1'),
    quantity: '10000',
    notice: { documentId: await addDocument(l.db, l.orgId, 'NOTICE_OF_EXERCISE'), receivedOn: '2026-10-20' },
    payment: { amount: '1000', receivedOn: '2026-10-20', method: 'ACH', reference: 'EX-OPT-1' },
    exerciseDate: '2026-10-20',
    fmv: { source: 'valuation', valuationId: l.id('V5') },
    tax: { treatment: 'W2' },
    ...extra,
  }
}

async function dryRun(l: LedgerHarness, name: string, body: unknown) {
  const response = await l.api('POST', l.path(`/commands/${name}?dryRun=true`), l.rw, body)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

function codesOf(body: unknown): string[] {
  return ((body as { error?: { violations?: { code: string }[] } }).error?.violations ?? []).map((violation) => violation.code)
}

describe("the exercise's lots and portions", () => {
  it('are derived by the server for the exercise date, ISO first, and the real call must send them back exactly', async () => {
    const l = await ledgerHarness()
    const body = await exerciseBody(l)
    const preview = await dryRun(l, 'exercise-option', body)
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    const shown = api.commandResultSchema.parse(preview.body)
    const split = shown.exercise!
    expect(split).toMatchObject({ date: '2026-10-20', lots: { iso: '10000', nso: '0' }, portions: [{ portion: 'ISO', quantity: '10000', reason: null }] })
    expect(Number(split.isoAvailable)).toBeGreaterThanOrEqual(10000)
    const displayId = split.portions[0]!.displayId
    expect(displayId).toMatch(/^CS-\d+$/)

    // Anything but the derived split is refused: other portions, lots that don't add up, and (on the real call) any
    // other result than the reviewed one, here a display ID of its own choosing.
    expect(codesOf((await dryRun(l, 'exercise-option', { ...body, resultingShares: [{ portion: 'NSO' }] })).body)).toContain('RESULTING_SHARES_PORTIONS')
    expect(codesOf((await dryRun(l, 'exercise-option', { ...body, lots: [{ portion: 'ISO', quantity: '6000' }] })).body)).toContain('LOTS_MISMATCH')
    const commitWith = (extra: Record<string, unknown>, key: string = crypto.randomUUID()) => l.api('POST', l.path('/commands/exercise-option'), l.rw, {
      ...body, ...extra, expectedLedgerSeq: shown.ledgerSeq, expectedDiffSha256: shown.diffSha256, acknowledge: shown.warnings.map((warning) => warning.code),
    }, { 'Idempotency-Key': key })
    const other = await commitWith({ lots: [{ portion: 'ISO', quantity: split.lots.iso }], resultingShares: [{ portion: 'ISO', displayId: 'CS-990' }] })
    expect(other.status).toBe(409)
    expect((await other.json() as { error: { reason: string } }).error.reason).toBe('state_changed')

    // The real call sends exactly what the dry run showed.
    const run = await commitWith({ lots: [{ portion: 'ISO', quantity: split.lots.iso }], resultingShares: split.portions.map((portion) => ({ portion: portion.portion, displayId: portion.displayId })) })
    const committed = await run.json() as unknown
    expect(run.status, JSON.stringify(committed)).toBe(200)
    const result = api.commandResultSchema.parse(committed)
    expect(result.exercise).toEqual(split)
    const lot = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${result.created.securityIds[0]}`)
    expect(lot).toMatchObject({ displayId, family: 'STOCK', numbers: { outstanding: '10000' } })
  })

  it('are all NSO for an NSO grant', async () => {
    const l = await ledgerHarness()
    const nso = await dryRun(l, 'exercise-option', await exerciseBody(l, { securityId: l.id('OPT-4'), payment: { amount: '1000', receivedOn: '2026-10-20', method: 'ACH', reference: 'EX-OPT-4' }, tax: { treatment: 'FORM_1099_NEC' } }))
    expect(nso.status, JSON.stringify(nso.body)).toBe(200)
    expect(api.commandResultSchema.parse(nso.body).exercise).toMatchObject({ isoAvailable: '0', lots: { iso: '0', nso: '10000' }, portions: [{ portion: 'NSO', quantity: '10000', reason: null }] })
  })

  it('are all NSO after the ISO deadline, with that reason', async () => {
    // OPT-20's ISO deadline is 2026-11-30 (three months after S21's termination); its contractual one, 2027-02-28.
    const late = await ledgerHarness({ now: Date.UTC(2026, 11, 10, 20) })
    const memo = await addDocument(late.db, late.orgId, 'VALUATION_SUPPORT')
    const answer = await dryRun(late, 'exercise-option', await exerciseBody(late, {
      securityId: late.id('OPT-20'),
      notice: { documentId: await addDocument(late.db, late.orgId, 'NOTICE_OF_EXERCISE'), receivedOn: '2026-12-10' },
      payment: { amount: '3100', receivedOn: '2026-12-10', method: 'ACH', reference: 'x' },
      exerciseDate: '2026-12-10',
      fmv: { source: 'manual', pricePerShare: '0.95', sourceNote: 'Valuation in progress; the last price applies', documentId: memo },
      tax: { treatment: 'W2', zeroReason: 'Former employee, no payroll' },
    }))
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(api.commandResultSchema.parse(answer.body).exercise).toMatchObject({
      date: '2026-12-10', portions: [{ portion: 'NSO', quantity: '10000', reason: 'AFTER_ISO_DEADLINE' }],
    })
  })
})

describe("reverseValuationEvent's confirmation", () => {
  it("is the valuation's name, exactly; the event's id is no longer accepted", async () => {
    const l = await ledgerHarness()
    // The flag lands on the 409A presumptively valid on its date: V5, named "409A V5".
    const valuationId = l.id('V5')
    const flag = await l.api('POST', l.path('/valuations/material-events'), l.rw, {
      eventDate: '2026-10-20', description: 'Signed term sheet for a priced round',
    }, { 'Idempotency-Key': crypto.randomUUID() })
    const flagged = api.valuationSchema.parse(await flag.json())
    expect(flag.status).toBe(200)
    expect(flagged).toMatchObject({ id: valuationId, name: '409A V5' })
    const eventId = flagged.events.find((event) => event.kind === 'MATERIAL_EVENT')!.id
    const reverse = (confirmation: string) => l.api('POST', l.path(`/valuations/${valuationId}/events/${eventId}/reverse`), l.sa, {
      note: 'Flagged against the wrong valuation', confirmation,
    }, { 'Idempotency-Key': crypto.randomUUID() })
    expect((await reverse(eventId)).status).toBe(400)
    expect((await reverse('409a v5')).status).toBe(400)
    const done = await reverse(` ${flagged.name} `)
    expect(done.status, await done.clone().text()).toBe(200)
  })
})

describe('dry runs without the typed confirmation', () => {
  it('preview cancel-security, mark-executed and extend-exercise-deadline; the real call still needs it', async () => {
    const l = await ledgerHarness()
    const cancel = { securityId: l.id('OPT-55'), effectiveDate: '2026-10-21', reason: 'NOT_EXECUTED', documentId: await addDocument(l.db, l.orgId, 'OTHER') }
    const cancelPreview = await dryRun(l, 'cancel-security', cancel)
    expect(cancelPreview.status, JSON.stringify(cancelPreview.body)).toBe(200)
    const shown = api.commandResultSchema.parse(cancelPreview.body)
    const real = await l.api('POST', l.path('/commands/cancel-security'), l.rw, { ...cancel, expectedLedgerSeq: shown.ledgerSeq, expectedDiffSha256: shown.diffSha256, acknowledge: [] })
    expect(real.status).toBe(400)
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-55')}`)).status).not.toBe('CANCELLED')
    // A wrong confirmation on a dry run is still a 400: it is optional there, not ignored when sent.
    expect((await dryRun(l, 'cancel-security', { ...cancel, confirmation: '' })).status).toBe(400)

    const markExecuted = { securityId: l.id('OPT-55'), executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signatureDates: { company: '2026-10-20' }, attestation: 'This PDF bears both signatures' }
    const executed = await dryRun(l, 'mark-executed', markExecuted)
    expect(executed.status, JSON.stringify(executed.body)).toBe(200)
    const extend = { securityId: l.id('OPT-20'), newContractualDeadline: '2027-06-30', documentId: await addDocument(l.db, l.orgId, 'COUNSEL_MEMO'), note: 'Board approved the extension' }
    const extension = await l.api('POST', l.path('/commands/extend-exercise-deadline?dryRun=true'), l.sa, extend)
    expect(extension.status, await extension.clone().text()).toBe(200)
  })
})

describe("a lot's last reversible command", () => {
  it('names the newest command reverse-command would accept now, or null', async () => {
    const l = await ledgerHarness()
    // A migrated grant: its issuance is migrated history, nothing on it is reversible.
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-1')}`)).lastReversibleCommandId).toBeNull()
    // An exercise recorded in the app is: on the option and on the shares it created.
    const exercise = api.commandResultSchema.parse((await runCommand(l, l.rw, 'exercise-option', await exerciseBody(l))).body)
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-1')}`)).lastReversibleCommandId).toBe(exercise.commandId)
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${exercise.created.securityIds[0]}`)).lastReversibleCommandId).toBe(exercise.commandId)
    // Once it is reversed, there is nothing left to reverse on the lot.
    const preview = await getJson<api.ReversalPreview>(l, l.sa, `/commands/${exercise.commandId}/reversal-preview`)
    const reversal = await l.api('POST', l.path('/commands/reverse-command'), l.sa, {
      commandId: exercise.commandId, note: 'Recorded against the wrong option', confirmation: 'OPT-1',
      expectedLedgerSeq: preview.ledgerSeq, expectedDiffSha256: preview.diffSha256,
    }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(reversal.status, await reversal.clone().text()).toBe(200)
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-1')}`)).lastReversibleCommandId).toBeNull()
  })
})

describe('a bulk cancellation', () => {
  async function cancelBody(l: LedgerHarness, label: string, extra: Record<string, unknown> = {}) {
    return { securityId: l.id(label), effectiveDate: '2026-10-21', reason: 'HOLDER_WAIVER', documentId: await addDocument(l.db, l.orgId, 'OTHER'), ...extra }
  }
  function commitWith(l: LedgerHarness, body: Record<string, unknown>, shown: { ledgerSeq: number; diffSha256: string }, confirmation: string) {
    return l.api('POST', l.path('/commands/cancel-security'), l.rw, {
      ...body, confirmation, expectedLedgerSeq: shown.ledgerSeq, expectedDiffSha256: shown.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': crypto.randomUUID() })
  }

  it('commits each later grant without a new review when its re-run dry run has the reviewed effect', async () => {
    const l = await ledgerHarness()
    const first = await cancelBody(l, 'OPT-55')
    const second = await cancelBody(l, 'OPT-56')
    // Both reviewed at the same head; each moves the plan's pool, a total every cancellation moves.
    const reviewed = [
      api.commandResultSchema.parse((await dryRun(l, 'cancel-security', first)).body),
      api.commandResultSchema.parse((await dryRun(l, 'cancel-security', second)).body),
    ] as const
    expect(reviewed[0].ledgerSeq).toBe(reviewed[1].ledgerSeq)
    expect(reviewed[1].changes.map((change) => change.entity)).toContain('pool')
    expect((await commitWith(l, first, reviewed[0], 'OPT-55')).status).toBe(200)
    // The head moved, so the second grant's reviewed seq is stale: a single command's guard is unchanged.
    const stale = await commitWith(l, second, reviewed[1], 'OPT-56')
    expect(stale.status).toBe(409)
    expect((await stale.json() as { error: { reason: string } }).error.reason).toBe('stale_ledger')
    // The re-run dry run shows new pool totals: its exact diff hash changed, its effect hash didn't.
    const again = api.commandResultSchema.parse((await dryRun(l, 'cancel-security', second)).body)
    expect(again.ledgerSeq).toBeGreaterThan(reviewed[1].ledgerSeq)
    expect(again.changes.find((change) => change.entity === 'pool')).not.toEqual(reviewed[1].changes.find((change) => change.entity === 'pool'))
    expect(again.diffSha256).not.toBe(reviewed[1].diffSha256)
    expect(again.effectSha256).toBe(reviewed[1].effectSha256)
    // The old diff hash never commits a different diff, even with the new seq.
    const old = await commitWith(l, second, { ledgerSeq: again.ledgerSeq, diffSha256: reviewed[1].diffSha256 }, 'OPT-56')
    expect(old.status).toBe(409)
    expect((await old.json() as { error: { reason: string } }).error.reason).toBe('state_changed')
    // So the UI commits it with the new seq and the new exact diff hash, without asking again.
    const done = await commitWith(l, second, again, 'OPT-56')
    expect(done.status, await done.clone().text()).toBe(200)
  })

  it('changes the effect hash, so the UI asks again, when the grant itself moved in between', async () => {
    const l = await ledgerHarness()
    const full = await cancelBody(l, 'OPT-56')
    const reviewed = api.commandResultSchema.parse((await dryRun(l, 'cancel-security', full)).body)
    const part = await cancelBody(l, 'OPT-56', { quantity: '4000' })
    const shown = api.commandResultSchema.parse((await dryRun(l, 'cancel-security', part)).body)
    expect((await commitWith(l, part, shown, 'OPT-56')).status).toBe(200)
    const again = api.commandResultSchema.parse((await dryRun(l, 'cancel-security', full)).body)
    expect(again.effectSha256).not.toBe(reviewed.effectSha256)
    expect(again.diffSha256).not.toBe(reviewed.diffSha256)
  })
})

describe("the exercise's lots past the ISO $100K limit", () => {
  // OPT-33 (S13: 400,000 ISO at 0.95 from 2025-11-17): 108,333 shares vest in 2026, 105,263 of them ISO lots and 3,070
  // NSO lots over the $100K limit (golden §3.9). By 2026-12-18 all of them have vested; no 409A is valid then.
  async function lateBody(l: LedgerHarness, quantity: string, cost: string, extra: Record<string, unknown> = {}) {
    return {
      securityId: l.id('OPT-33'),
      quantity,
      notice: { documentId: await addDocument(l.db, l.orgId, 'NOTICE_OF_EXERCISE'), receivedOn: '2026-12-18' },
      payment: { amount: cost, receivedOn: '2026-12-18', method: 'ACH', reference: 'EX-OPT-33' },
      exerciseDate: '2026-12-18',
      fmv: { source: 'manual', pricePerShare: '1.1', sourceNote: "Valuation in progress; the board's estimate applies", documentId: await addDocument(l.db, l.orgId, 'VALUATION_SUPPORT') },
      tax: { treatment: 'W2', zeroReason: 'Withheld through the next payroll' },
      ...extra,
    }
  }

  it('derives the ISO lots first and the NSO lots over the limit, and the real call commits exactly them', async () => {
    const l = await ledgerHarness({ now: Date.UTC(2026, 11, 20, 20) })
    const body = await lateBody(l, '108333', '102916.35')
    const preview = await dryRun(l, 'exercise-option', body)
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    const shown = api.commandResultSchema.parse(preview.body)
    expect(shown.exercise).toMatchObject({
      date: '2026-12-18', isoAvailable: '105263', lots: { iso: '105263', nso: '3070' },
      portions: [{ portion: 'ISO', quantity: '105263', reason: null }, { portion: 'NSO', quantity: '3070', reason: 'ISO_LIMIT' }],
    })
    const split = shown.exercise!
    const run = await l.api('POST', l.path('/commands/exercise-option'), l.rw, {
      ...body,
      lots: [{ portion: 'ISO', quantity: split.lots.iso }, { portion: 'NSO', quantity: split.lots.nso }],
      resultingShares: split.portions.map((portion) => ({ portion: portion.portion, displayId: portion.displayId })),
      expectedLedgerSeq: shown.ledgerSeq, expectedDiffSha256: shown.diffSha256, acknowledge: shown.warnings.map((warning) => warning.code),
    }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(run.status, await run.clone().text()).toBe(200)
    expect(api.commandResultSchema.parse(await run.json()).created.securityIds).toHaveLength(2)
  })

  it('takes another lot choice only with its reason', async () => {
    const l = await ledgerHarness({ now: Date.UTC(2026, 11, 20, 20) })
    // ISO first, 50,000 shares are all ISO lots.
    const plain = api.commandResultSchema.parse((await dryRun(l, 'exercise-option', await lateBody(l, '50000', '47500'))).body)
    expect(plain.exercise).toMatchObject({ lots: { iso: '50000', nso: '0' }, portions: [{ portion: 'ISO', quantity: '50000', reason: null }] })
    // The NSO lots first instead: refused without a reason, recorded as a lot choice with one.
    const chosen = [{ portion: 'ISO', quantity: '46930' }, { portion: 'NSO', quantity: '3070' }]
    expect(codesOf((await dryRun(l, 'exercise-option', await lateBody(l, '50000', '47500', { lots: chosen }))).body)).toContain('LOT_CHOICE_NEEDS_REASON')
    const reasoned = await dryRun(l, 'exercise-option', await lateBody(l, '50000', '47500', { lots: chosen, lotReason: 'The holder asked to use the NSO lots first' }))
    expect(reasoned.status, JSON.stringify(reasoned.body)).toBe(200)
    expect(api.commandResultSchema.parse(reasoned.body).exercise).toMatchObject({
      lots: { iso: '46930', nso: '3070' },
      portions: [{ portion: 'ISO', quantity: '46930', reason: null }, { portion: 'NSO', quantity: '3070', reason: 'LOT_CHOICE' }],
    })
  })
})
