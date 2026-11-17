import type { Fact } from './types.ts'

// Questions to try in a new collection (design J1 step 4, COL-01): made from the facts it shows, one per document, in
// the order they are shown. Each asks whether a fact holds, in the fact's own words, so it is answered from the passage
// the fact came from, with its source. Nothing is asked to make them, and the same facts always give the same questions.

/** Shorter questions read better as buttons: one is longer only when its document has nothing shorter. */
const SHORT = 140

/** "<the fact> — is that right?"; null for a fact that is empty or was cut short. */
export function factQuestion(fact: Pick<Fact, 'sentence'>): string | null {
  const sentence = fact.sentence.replace(/\s+/g, ' ').trim()
  if (sentence.endsWith('…')) return null
  const body = sentence.replace(/[\s.!?;:,]+$/u, '')
  return body ? `${body} — is that right?` : null
}

/**
 * Up to `max` questions from the facts, in the order they are given: one per document, the first short one of each
 * (or its shortest), so they come from different files.
 */
export function suggestedQuestions(facts: Pick<Fact, 'sentence' | 'documentId'>[], max = 3): string[] {
  const byDocument = new Map<string, string[]>()
  for (const fact of facts) {
    const question = factQuestion(fact)
    if (!question) continue
    byDocument.set(fact.documentId, [...(byDocument.get(fact.documentId) ?? []), question])
  }
  const picked: string[] = []
  for (const questions of byDocument.values()) {
    if (picked.length >= max) break
    const pick = questions.find((question) => question.length <= SHORT) ?? [...questions].sort((a, b) => a.length - b.length)[0]
    if (pick && !picked.includes(pick)) picked.push(pick)
  }
  return picked
}
