import { gettingStarted } from "./gettingStarted.tsx";
import { glossary } from "./glossary.tsx";
import { profile } from "./profile.tsx";
import { TOPIC_SLUGS, type DocTopic, type TopicSlug } from "./parts.tsx";
import { taxBasics } from "./taxBasics.tsx";
import { usTaxBasics } from "./usTaxBasics.tsx";

// The docs' topics, in reading order: the order of the topic list and of "Previous" and "Next".

const BY_SLUG: Record<TopicSlug, DocTopic> = {
  "getting-started": gettingStarted,
  profile,
  "tax-basics": taxBasics,
  "us-tax-basics": usTaxBasics,
  glossary,
};

export const DOC_TOPICS: readonly DocTopic[] = TOPIC_SLUGS.map((slug) => BY_SLUG[slug]);

/** The topic an address names; with no topic in the address, Getting started. Undefined for one that doesn't exist. */
export function docTopic(slug: string | undefined): DocTopic | undefined {
  return DOC_TOPICS.find((topic) => topic.slug === (slug ?? "getting-started"));
}
