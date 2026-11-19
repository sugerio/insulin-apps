import type { HidingRules } from '../../../engine/src/contract.ts'
import { applyHiding } from './hiding.ts'

/**
 * Text Knowledge keeps in D1 that people wrote for a collection — corrections, and notes waiting for the 1st — is kept
 * with the organization's hidden values hidden, by the same detectors the engine applies before learning (hiding.ts):
 * never a value the rules remove. When the rules get stricter, what was kept is hidden again (`hideKept`).
 */
export function hide(text: string, rules: HidingRules): string {
  return applyHiding(text, rules).text
}

export function hiddenNote<T extends { title: string; text: string }>(note: T, rules: HidingRules): T {
  return { ...note, title: hide(note.title, rules), text: hide(note.text, rules) }
}

/**
 * Hides again, with the organization's rules now, what its corrections and waiting notes keep (after the rules got
 * stricter, or for rows kept before Knowledge hid them). Only rows that change are written, 50 to a batch.
 */
export async function hideKept(db: D1Database, org: string, rules: HidingRules): Promise<number> {
  const statements: D1PreparedStatement[] = []
  const corrections = await db.prepare(`SELECT id, text, question FROM corrections WHERE org_id = ?`).bind(org).all<{ id: string; text: string; question: string | null }>()
  for (const row of corrections.results) {
    const text = hide(row.text, rules)
    const question = row.question === null ? null : hide(row.question, rules)
    if (text !== row.text || question !== row.question) statements.push(db.prepare(`UPDATE corrections SET text = ?, question = ? WHERE id = ? AND org_id = ?`).bind(text, question, row.id, org))
  }
  const waiting = await db.prepare(`SELECT id, request FROM imports WHERE org_id = ? AND request IS NOT NULL`).bind(org).all<{ id: string; request: string }>()
  for (const row of waiting.results) {
    let request: { notes?: { title: string; text: string }[]; hidden?: boolean }
    try {
      request = JSON.parse(row.request) as typeof request
    } catch {
      continue
    }
    const next = JSON.stringify({ ...request, notes: (request.notes ?? []).map((note) => hiddenNote(note, rules)), hidden: true })
    if (next !== row.request) statements.push(db.prepare(`UPDATE imports SET request = ? WHERE id = ? AND org_id = ? AND request IS NOT NULL`).bind(next, row.id, org))
  }
  for (let from = 0; from < statements.length; from += 50) await db.batch(statements.slice(from, from + 50))
  return statements.length
}
