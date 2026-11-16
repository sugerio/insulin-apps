import { Hono } from 'hono'
import { z } from 'zod'
import { bestPassages, logQuestion, requireCollections, searchTargets, targetsOf, TOP_K, waitingMessage, writeAnswer, type CollectionResult } from '../ask.ts'
import type { AppEnv } from '../env.ts'
import { ApiError, readJson } from '../http.ts'
import { callerOf, json, now } from './common.ts'

const collectionsSchema = z.unknown().optional()

function perCollection(results: CollectionResult[]) {
  return results.map((result) => ({ id: result.collectionId, name: result.name, status: result.status, retryAfterSeconds: result.retryAfterSeconds, covered: result.covered }))
}

/** The overall status when no collection answered: learning wins, then waking, then busy. */
function waitingStatus(results: CollectionResult[]): 'learning' | 'waking' | 'busy' {
  if (results.some((result) => result.status === 'learning')) return 'learning'
  if (results.some((result) => result.status === 'waking')) return 'waking'
  return 'busy'
}

export function askingRoutes() {
  const app = new Hono<AppEnv>()

  // The site: a written answer from the passages only, with checked citations, or "I won't guess". AI assistants and
  // API clients search instead and write their own answer.
  app.post('/ask', async (c) => {
    const caller = callerOf(c)
    if (caller.via !== 'browser') {
      throw new ApiError('browser_only', 'AI assistants and API clients search with POST /api/search and write their own answer from the passages.')
    }
    const body = await readJson(c, z.object({ collections: collectionsSchema, question: z.string().trim().min(1, 'ask a question').max(2000) }).strict())
    const ids = requireCollections(body.collections)
    const at = now(c)
    if (!c.env.ENGINE) throw new ApiError('engine_unavailable', "Knowledge's engine isn't available here, so questions can't be answered right now.")
    const { targets, skipped } = await targetsOf(c.env.DB, caller, ids)
    const results = await searchTargets(c.env, c.env.ENGINE, caller, targets, body.question, TOP_K, at)
    const answerId = crypto.randomUUID()
    if (!results.some((result) => result.status === 'ok')) {
      const retry = Math.max(...results.map((result) => result.retryAfterSeconds ?? 60))
      return json(c, { answerId: null, outcome: 'waiting', status: waitingStatus(results), message: waitingMessage(results), retryAfterSeconds: retry, text: null, citations: [], sources: [], collections: perCollection(results), skipped })
    }
    const passages = bestPassages(results, TOP_K)
    const written = await writeAnswer(c.env, c.env.ENGINE, caller, body.question, results, passages, at)
    await logQuestion(c.env.DB, caller, answerId, body.question, results, written.outcome, written.model, at)
    const sources = written.outcome === 'wont_guess' ? [] : passages.map((passage, index) => ({ n: index + 1, ...passage }))
    return json(c, {
      answerId,
      outcome: written.outcome,
      text: written.text,
      model: written.model,
      writer: written.writer,
      message: written.message,
      citations: written.citations.map((n) => {
        const passage = passages[n - 1]!
        return { n, passageId: passage.passageId, documentId: passage.documentId, documentName: passage.documentName, collectionId: passage.collectionId, page: passage.page, start: passage.start, end: passage.end }
      }),
      sources,
      // Some collections may still be waking or learning; they are listed with their status.
      collections: perCollection(results),
      skipped,
    })
  })

  // AI assistants and API clients (and the site): passages with their file, page and position, and `covered`.
  app.post('/search', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ collections: collectionsSchema, query: z.string().trim().min(1, 'ask a question').max(2000), topK: z.number().int().min(1).max(20).optional() }).strict())
    const ids = requireCollections(body.collections)
    const at = now(c)
    if (!c.env.ENGINE) throw new ApiError('engine_unavailable', "Knowledge's engine isn't available here, so questions can't be answered right now.")
    const { targets, skipped } = await targetsOf(c.env.DB, caller, ids)
    const results = await searchTargets(c.env, c.env.ENGINE, caller, targets, body.query, body.topK ?? TOP_K, at)
    const answered = results.some((result) => result.status === 'ok')
    if (!answered) {
      return json(c, {
        status: waitingStatus(results),
        retryAfterSeconds: Math.max(...results.map((result) => result.retryAfterSeconds ?? 60)),
        message: waitingMessage(results),
        covered: false,
        passages: [],
        facts: [],
        collections: perCollection(results),
        skipped,
      })
    }
    const covered = results.some((result) => result.covered)
    const answerId = crypto.randomUUID()
    await logQuestion(c.env.DB, caller, answerId, body.query, results, covered ? 'searched' : 'wont_guess', null, at)
    const names = results.filter((result) => result.status === 'ok').map((result) => `“${result.name}”`).join(', ')
    return json(c, {
      status: 'ok',
      retryAfterSeconds: null,
      covered,
      message: covered ? null : `Nothing in ${names} covers this. Say you won't guess, rather than answering without a source.`,
      passages: covered ? bestPassages(results, body.topK ?? TOP_K) : [],
      facts: results.flatMap((result) => result.facts).slice(0, 10),
      collections: perCollection(results),
      skipped,
    })
  })

  return app
}
