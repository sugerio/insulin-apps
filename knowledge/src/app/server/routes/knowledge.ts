import { Hono } from 'hono'
import { z } from 'zod'
import type { PassageRef } from '../../../../engine/src/contract.ts'
import { authorize, type CollectionRow } from '../access.ts'
import type { EngineClient } from '../engine/client.ts'
import type { AppEnv } from '../env.ts'
import { ApiError, badRequest, notFound, readJson } from '../http.ts'
import { idempotent, stableId } from '../idempotency.ts'
import { hide } from '../kept.ts'
import { readOrgSettings } from '../settings.ts'
import { appLink, MAIL, sendMail, sendMailToAll } from '../mail.ts'
import { memberOf } from '../members.ts'
import { callerOf, engineFor, iso, json, now, param } from './common.ts'
import { refused, startImport } from './sources.ts'

/**
 * What a collection knows, and fixing it once (design sections 09 and 11): facts as sentences; corrections, which are
 * notes the engine learns ahead of other imports and which mark the passages they correct as outdated (tied to the
 * document and the passage's text hash), so new questions everywhere use them; and reports from people who can only
 * read, which go to the owner and the collection's admins until someone fixes or dismisses them.
 */
const refSchema = z.object({ documentId: z.string().min(1).max(200), textHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()

/**
 * The passage a fact came from, as an outdated mark: the fact names its passage's text hash, so nothing is searched
 * and a sleeping or learning collection isn't woken. Null when the fact is no longer listed.
 */
async function passageOfFact(engine: EngineClient, collection: CollectionRow, factId: string): Promise<PassageRef | null> {
  let cursor: string | null = null
  for (let page = 0; page < 40; page += 1) {
    const { facts, next } = await engine.facts(collection.id, cursor)
    const fact = facts.find((candidate) => candidate.factId === factId)
    if (fact) return { documentId: fact.documentId, textHash: fact.passageTextHash }
    if (!next) break
    cursor = next
  }
  return null
}

/**
 * The title of a fact's correction, which the engine learns with its text: the same few words for every fact, never
 * the fact itself (the wrong sentence being replaced) nor the name of the file it came from, which can say the same
 * wrong thing ("Discounts stop at 20 percent.md"). Learned again inside the correction, answers would quote either.
 */
const FACT_CORRECTION_TITLE = 'Correction to a fact'

/** Who added the documents a correction marks outdated (from the imports that learned them), other than `except`. */
async function authorsOf(db: D1Database, org: string, collectionId: string, documentIds: string[], except: string): Promise<{ id: string; files: string[] }[]> {
  if (!documentIds.length) return []
  const { results } = await db.prepare(
    `SELECT created_by, detail FROM imports WHERE org_id = ? AND collection_id = ? AND state = 'committed' AND created_by != ?`,
  ).bind(org, collectionId, except).all<{ created_by: string; detail: string }>()
  const authors = new Map<string, Set<string>>()
  for (const row of results) {
    let documents: { id: string; name: string }[] = []
    try {
      const parsed = (JSON.parse(row.detail) as { documents?: unknown }).documents
      documents = Array.isArray(parsed) ? parsed.filter((entry): entry is { id: string; name: string } => typeof entry?.id === 'string' && typeof entry?.name === 'string') : []
    } catch {
      documents = []
    }
    for (const document of documents) {
      if (!documentIds.includes(document.id)) continue
      if (!authors.has(row.created_by)) authors.set(row.created_by, new Set())
      authors.get(row.created_by)!.add(document.name)
    }
  }
  return [...authors].map(([id, files]) => ({ id, files: [...files] }))
}

export function knowledgeRoutes() {
  const app = new Hono<AppEnv>()

  // Facts as sentences, each with who checked it ("Looks right"), when someone has.
  app.get('/:id/facts', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'read')
    const page = await engineFor(c).facts(collection.id, c.req.query('cursor') ?? null)
    const ids = page.facts.map((fact) => fact.factId)
    const checks = new Map<string, { by: string | null; at: string | null }>()
    for (let from = 0; from < ids.length; from += 50) {
      const slice = ids.slice(from, from + 50)
      const { results } = await c.env.DB.prepare(
        `SELECT f.fact_id, f.checked_at, COALESCE(m.name, m.email) AS name FROM fact_checks f
         LEFT JOIN members m ON m.org_id = f.org_id AND m.principal_type = 'person' AND m.principal_id = f.checked_by
         WHERE f.org_id = ?1 AND f.collection_id = ?2 AND f.fact_id IN (${slice.map((_, index) => `?${index + 3}`).join(', ')})`,
      ).bind(collection.org_id, collection.id, ...slice).all<{ fact_id: string; checked_at: number; name: string | null }>()
      for (const row of results) checks.set(row.fact_id, { by: row.name, at: iso(row.checked_at) })
    }
    return json(c, { facts: page.facts.map((fact) => ({ ...fact, checked: checks.get(fact.factId) ?? null })), next: page.next })
  })

  // "Looks right": someone who can change the collection checked a fact. Kept here, so going back doesn't undo it.
  app.post('/:id/facts/:factId/check', async (c) => {
    const caller = callerOf(c)
    const factId = param(c, 'factId')
    if (!/^[A-Za-z0-9_:.-]{1,200}$/.test(factId)) throw badRequest('That fact is not valid. Reload What it knows and try again.')
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'change')
    const at = now(c)
    await c.env.DB.prepare(
      `INSERT INTO fact_checks (collection_id, fact_id, org_id, checked_by, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (collection_id, fact_id) DO UPDATE SET checked_by = excluded.checked_by, checked_at = excluded.checked_at`,
    ).bind(collection.id, factId, collection.org_id, caller.id, at).run()
    return json(c, { check: { factId, by: caller.name ?? caller.email, at: iso(at) } })
  })

  // Fix an answer or a fact once: a note the collection learns, marking what it corrects as outdated.
  app.post('/:id/corrections', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({
      text: z.string().trim().min(1, 'write the right answer').max(20_000),
      question: z.string().trim().max(2000).optional(),
      outdated: z.array(refSchema).max(20).optional(),
      factId: z.string().min(1).max(200).optional(),
      reportId: z.string().min(1).max(64).optional(),
      /** Tell the people who added the files it corrects (an e-mail with a link, not the correction). */
      notifyAuthors: z.boolean().optional(),
    }).strict())
    const db = c.env.DB
    const { collection } = await authorize(db, caller, param(c, 'id'), 'change')
    return idempotent(c, body, true, async () => {
      const at = now(c)
      const engine = engineFor(c)
      if (body.reportId) {
        const report = await db.prepare(`SELECT id FROM reports WHERE id = ? AND org_id = ? AND collection_id = ?`).bind(body.reportId, caller.organizationId, collection.id).first()
        if (!report) throw notFound('There is no such report in this collection.')
      }
      const outdated = [...(body.outdated ?? [])]
      let ofFact = false
      if (body.factId && !outdated.length) {
        const ref = await passageOfFact(engine, collection, body.factId)
        if (!ref) throw badRequest("That fact isn't in this collection any more. Reload What it knows and try again.")
        outdated.push(ref)
        ofFact = true
      }
      const importId = await stableId(c)
      const id = importId
      // The title is the server's: learned with the text, it holds only the question it answers, or for a fact's fix
      // the same neutral words, never the sentence the fix replaces or the name of the file that said it.
      const title = ofFact ? FACT_CORRECTION_TITLE : body.question ? `Correction: ${body.question}`.slice(0, 200) : 'Correction'
      const note = { noteId: id.replace(/-/g, ''), title, text: body.text, outdated }
      // Recorded first: a report it answers is marked fixed once the correction is learned (outbox.ts), not before.
      // Kept as the engine learns it, with the organization's hidden values hidden: Knowledge keeps none.
      const { hiding } = await readOrgSettings(db, caller.organizationId, at)
      await db.prepare(
        `INSERT INTO corrections (id, org_id, collection_id, created_by, created_at, question, text, outdated, import_id, report_id, fact_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      ).bind(id, caller.organizationId, collection.id, caller.id, at, body.question === undefined ? null : hide(body.question, hiding), hide(body.text, hiding), JSON.stringify(outdated), importId, body.reportId ?? null, body.factId ?? null).run()
      let started
      try {
        started = await startImport(c.env, engine, caller, collection, 'correction', { files: [], notes: [note] }, at, importId)
      } catch (error) {
        if (refused(error) || (error instanceof ApiError && error.status < 500)) await db.prepare(`DELETE FROM corrections WHERE id = ? AND org_id = ?`).bind(id, caller.organizationId).run()
        throw error
      }
      if (body.notifyAuthors) {
        const link = appLink(c.env, `/collections/${collection.id}/sources`)
        for (const author of await authorsOf(db, caller.organizationId, collection.id, outdated.map((ref) => ref.documentId), caller.id)) {
          const member = await memberOf(db, caller.organizationId, 'person', author.id)
          if (!member?.email || member.away) continue
          await sendMail(c.env, caller.organizationId, { to: member.email, ...MAIL.correctedYourFile(caller.name ?? caller.email ?? 'Someone', collection.name, author.files, link) }, 'corrected_your_file')
        }
      }
      return json(c, { correction: { id, outdated }, import: started.status, waiting: started.waiting }, 202)
    })
  })

  // "Still right": a correction to check (its file was read again) still says the right thing; Needs attention lets go.
  app.post('/:id/correction-checks/clear', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ noteId: z.string().min(1).max(100), documentId: z.string().min(1).max(200), textHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'change')
    const cleared = await c.env.DB.prepare(`DELETE FROM correction_checks WHERE collection_id = ? AND org_id = ? AND note_id = ? AND document_id = ? AND text_hash = ?`)
      .bind(collection.id, collection.org_id, body.noteId, body.documentId, body.textHash).run()
    if (cleared.meta.changes !== 1) throw notFound('There is no such correction to check in this collection.')
    return json(c, { cleared: true })
  })

  // "This answer is wrong": anyone who can ask; the owner and the collection's admins get an e-mail.
  app.post('/:id/reports', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({
      answerId: z.string().max(64).optional(),
      question: z.string().trim().min(1).max(2000),
      answer: z.string().max(8000).optional(),
      note: z.string().trim().max(2000).optional(),
    }).strict())
    const db = c.env.DB
    const { collection } = await authorize(db, caller, param(c, 'id'), 'report')
    return idempotent(c, body, true, async () => {
      const at = now(c)
      // The same id when the same request comes back after its answer was lost: one report, mailed once.
      const id = await stableId(c)
      const inserted = await db.prepare(`INSERT INTO reports (id, org_id, collection_id, answer_id, reported_by, created_at, question, answer, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open') ON CONFLICT (id) DO NOTHING`)
        .bind(id, caller.organizationId, collection.id, body.answerId ?? null, caller.id, at, body.question, body.answer ?? '', body.note ?? '').run()
      if (inserted.meta.changes !== 1) {
        const report = await db.prepare(`SELECT status, answer_id, created_at FROM reports WHERE id = ? AND org_id = ?`).bind(id, caller.organizationId).first<{ status: string; answer_id: string | null; created_at: number }>()
        return json(c, { report: { id, status: report?.status ?? 'open', answerId: report?.answer_id ?? null, createdAt: iso(report?.created_at ?? at) } }, 201)
      }
      const { results } = await db.prepare(
        `SELECT m.email FROM members m WHERE m.org_id = ?1 AND m.principal_type = 'person' AND m.away = 0 AND m.email IS NOT NULL AND (
           m.principal_id = ?2 OR EXISTS (SELECT 1 FROM collection_shares s WHERE s.collection_id = ?3 AND s.org_id = ?1 AND s.principal_type = 'person' AND s.principal_id = m.principal_id AND s.role = 'ADMIN' AND s.status = 'active'))`,
      ).bind(caller.organizationId, collection.owner_id, collection.id).all<{ email: string }>()
      await sendMailToAll(c.env, caller.organizationId, results.map((row) => row.email), MAIL.reported(caller.name ?? caller.email ?? 'Someone', collection.name, body.question, body.note ?? '', appLink(c.env, `/attention?collection=${collection.id}`)), 'reported')
      return json(c, { report: { id, status: 'open', answerId: body.answerId ?? null, createdAt: iso(at) } }, 201)
    })
  })

  app.get('/:id/reports', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'read')
    const status = c.req.query('status')
    const answerId = c.req.query('answerId')
    if (status !== undefined && !['open', 'fixed', 'dismissed'].includes(status)) throw badRequest('status is open, fixed or dismissed.')
    const { results } = await c.env.DB.prepare(
      `SELECT r.*, m.name AS reporter_name FROM reports r LEFT JOIN members m ON m.org_id = r.org_id AND m.principal_type = 'person' AND m.principal_id = r.reported_by
       WHERE r.org_id = ?1 AND r.collection_id = ?2 AND (?3 IS NULL OR r.status = ?3) AND (?4 IS NULL OR r.answer_id = ?4) ORDER BY r.created_at DESC LIMIT 200`,
    ).bind(caller.organizationId, collection.id, status ?? null, answerId ?? null).all<Record<string, unknown>>()
    return json(c, {
      reports: results.map((row) => ({
        id: row.id, answerId: row.answer_id, question: row.question, answer: row.answer, note: row.note, status: row.status,
        reportedBy: { id: row.reported_by, name: row.reporter_name ?? null }, createdAt: iso(row.created_at as number),
        resolvedAt: iso(row.resolved_at as number | null), correctionId: row.correction_id,
      })),
    })
  })

  // Settle a report: fixed (usually with a correction) or dismissed (the answer is right).
  app.patch('/:id/reports/:reportId', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ status: z.enum(['fixed', 'dismissed']), correctionId: z.string().max(64).optional() }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'change')
    const result = await c.env.DB.prepare(
      `UPDATE reports SET status = ?1, resolved_by = ?2, resolved_at = ?3, correction_id = COALESCE(?4, correction_id) WHERE id = ?5 AND org_id = ?6 AND collection_id = ?7`,
    ).bind(body.status, caller.id, now(c), body.correctionId ?? null, param(c, 'reportId'), caller.organizationId, collection.id).run()
    if (result.meta.changes !== 1) throw notFound('There is no such report in this collection.')
    return json(c, { report: { id: param(c, 'reportId'), status: body.status } })
  })

  return app
}
