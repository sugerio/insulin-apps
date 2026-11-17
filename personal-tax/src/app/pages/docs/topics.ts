import { gettingStarted } from "./gettingStarted.tsx";
import { glossary } from "./glossary.tsx";
import { household } from "./household.tsx";
import { TOPIC_SLUGS, type DocTopic, type TopicSlug } from "./parts.tsx";
import { taxBasics } from "./taxBasics.tsx";

// The docs' topics, in reading order: the order of the topic list and of "Previous" and "Next".

const BY_SLUG: Record<TopicSlug, DocTopic> = {
  "getting-started": gettingStarted,
  household,
  "tax-basics": taxBasics,
  glossary,
};

export const DOC_TOPICS: readonly DocTopic[] = TOPIC_SLUGS.map((slug) => BY_SLUG[slug]);

/** The topic an address names; with no topic in the address, Getting started. Undefined for one that doesn't exist. */
export function docTopic(slug: string | undefined): DocTopic | undefined {
  return DOC_TOPICS.find((topic) => topic.slug === (slug ?? "getting-started"));
}
