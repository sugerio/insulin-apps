import { aiAssistantsAndApi } from './aiAssistantsAndApi.tsx'
import { asking } from './asking.tsx'
import { collectionsAndSources } from './collectionsAndSources.tsx'
import { fixingAndReporting } from './fixingAndReporting.tsx'
import { gettingStarted } from './gettingStarted.tsx'
import { glossary } from './glossary.tsx'
import { hidingPersonalData } from './hidingPersonalData.tsx'
import { history } from './history.tsx'
import { limits } from './limits.tsx'
import { TOPIC_SLUGS, type DocTopic, type TopicSlug } from './parts.tsx'
import { sharingAndRoles } from './sharingAndRoles.tsx'
import { yourData } from './yourData.tsx'

// The docs' topics, in reading order: the order of the topic list and of "Previous" and "Next".

const BY_SLUG: Record<TopicSlug, DocTopic> = {
  'getting-started': gettingStarted,
  'collections-and-sources': collectionsAndSources,
  asking,
  'fixing-and-reporting': fixingAndReporting,
  'sharing-and-roles': sharingAndRoles,
  history,
  'ai-assistants-and-api': aiAssistantsAndApi,
  'hiding-personal-data': hidingPersonalData,
  limits,
  'your-data': yourData,
  glossary,
}

export const DOC_TOPICS: readonly DocTopic[] = TOPIC_SLUGS.map((slug) => BY_SLUG[slug])

/** The topic an address names; with no topic in the address, `fallback`. Undefined for a topic that doesn't exist. */
export function docTopic(slug: string | undefined, fallback: TopicSlug = 'getting-started'): DocTopic | undefined {
  return DOC_TOPICS.find((topic) => topic.slug === (slug ?? fallback))
}
