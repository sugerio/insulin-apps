import { equityBasics } from "./equityBasics.tsx";
import { everydayTasks } from "./everydayTasks.tsx";
import { forStakeholders } from "./forStakeholders.tsx";
import { gettingStarted } from "./gettingStarted.tsx";
import { glossary } from "./glossary.tsx";
import { importing } from "./importing.tsx";
import { TOPIC_SLUGS, type DocTopic, type TopicSlug } from "./parts.tsx";

// The docs' topics, in reading order: the order of the topic list and of "Previous" and "Next".

const BY_SLUG: Record<TopicSlug, DocTopic> = {
  "getting-started": gettingStarted,
  importing,
  "everyday-tasks": everydayTasks,
  "for-stakeholders": forStakeholders,
  "equity-basics": equityBasics,
  glossary,
};

export const DOC_TOPICS: readonly DocTopic[] = TOPIC_SLUGS.map((slug) => BY_SLUG[slug]);

/** The topic an address names; with no topic in the address, `fallback`. Undefined for a topic that doesn't exist. */
export function docTopic(slug: string | undefined, fallback: TopicSlug): DocTopic | undefined {
  return DOC_TOPICS.find((topic) => topic.slug === (slug ?? fallback));
}
