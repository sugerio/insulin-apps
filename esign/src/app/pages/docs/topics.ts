import { eSignatures } from './eSignatures.ts'
import { evidence } from './evidence.ts'
import { gettingStarted } from './gettingStarted.ts'
import { glossary } from './glossary.ts'
import { roles } from './roles.ts'
import { sending } from './sending.ts'
import { signers } from './signers.ts'
import { statuses } from './statuses.ts'
import { templates } from './templates.ts'
import { TOPIC_SLUGS, type DocTopic, type TopicSlug } from './parts.ts'

// The Docs' topics, in reading order: the order of the topic list and of "Previous" and "Next".

const BY_SLUG: Record<TopicSlug, DocTopic> = {
  'getting-started': gettingStarted,
  sending,
  templates,
  signers,
  statuses,
  evidence,
  roles,
  'e-signatures': eSignatures,
  glossary,
}

export const DOC_TOPICS: readonly DocTopic[] = TOPIC_SLUGS.map((slug) => BY_SLUG[slug])

/** The topic an address names; with no topic in the address, Getting started. Undefined for a topic that doesn't exist. */
export function docTopic(slug: string | undefined): DocTopic | undefined {
  return DOC_TOPICS.find((topic) => topic.slug === (slug ?? 'getting-started'))
}
