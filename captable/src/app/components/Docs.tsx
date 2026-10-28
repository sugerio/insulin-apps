import "./docs.css";
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import { DocsBaseContext, type DocTopic } from "../pages/docs/parts.tsx";
import { DOC_TOPICS } from "../pages/docs/topics.ts";
import { Banner } from "./Feedback.tsx";

// The in-app Docs, the same in every frame (the admin workspace, the holder's portfolio and the standalone pages): the
// topic list beside the topic, which opens with its title, the "On this page" list of its sections and, on equity and
// tax topics, the note that it is general information. Every heading has an id, so a section can be linked from another
// topic (`…/docs/equity-basics#vesting`); arriving on one scrolls it into view and moves the focus to it.

const GROUPS = [["app", "Using Cap Table"], ["equity", "Equity and cap tables"]] as const;

/** The id an address's "#…" names (a malformed escape is taken as it is, never thrown). */
function hashId(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

export function Docs({ base, topic }: { base: string; topic: DocTopic }) {
  const location = useLocation();
  const layout = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // The topic shown before this render: a new topic takes the focus to its title, a first render leaves the focus alone.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const previous = shown.current;
    shown.current = topic.slug;
    const id = hashId(location.hash);
    const target = id ? document.getElementById(id) : null;
    if (target && article.current?.contains(target)) {
      target.scrollIntoView?.({ block: "start" });
      target.focus({ preventScroll: true });
      return;
    }
    // A topic chosen further down the page starts at its top.
    if ((layout.current?.getBoundingClientRect().top ?? 0) < 0) window.scrollTo?.(0, 0);
    if (previous !== null && previous !== topic.slug) title.current?.focus({ preventScroll: true });
  }, [topic.slug, location.hash, location.key]);

  const index = DOC_TOPICS.indexOf(topic);
  const before = DOC_TOPICS[index - 1];
  const after = DOC_TOPICS[index + 1];
  const href = (slug: string, section?: string) => `${base}/${slug}${section ? `#${section}` : ""}`;
  return (
    <DocsBaseContext value={base}>
      <div className="docs-layout" ref={layout}>
        <nav className="docs-topics" aria-label="Docs topics">
          {GROUPS.map(([group, label]) => (
            <div key={group} className="docs-topic-group">
              <p className="docs-topic-label" id={`docs-group-${group}`}>{label}</p>
              <ul aria-labelledby={`docs-group-${group}`}>
                {DOC_TOPICS.filter((item) => item.group === group).map((item) => {
                  const current = item.slug === topic.slug;
                  return (
                    <li key={item.slug}>
                      <Link to={href(item.slug)} className={current ? "active" : undefined} aria-current={current ? "page" : undefined}>{item.title}</Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <article className="card docs-article" ref={article} aria-labelledby="docs-title">
          <header className="docs-head">
            <h1 id="docs-title" ref={title} tabIndex={-1}>{topic.title}</h1>
            <p className="docs-lead">{topic.summary}</p>
          </header>
          {topic.generalInformation ? <GeneralInformation /> : null}
          <nav className={topic.compactContents ? "docs-toc compact" : "docs-toc"} aria-label="On this page">
            <p className="docs-toc-title" aria-hidden="true">On this page</p>
            <ul>
              {topic.sections.map((section) => <li key={section.id}><Link to={href(topic.slug, section.id)}>{section.title}</Link></li>)}
            </ul>
          </nav>
          {topic.sections.map((section) => (
            <section key={section.id} className="docs-section">
              <h2 id={section.id} tabIndex={-1}>{section.title}</h2>
              {section.body}
            </section>
          ))}
          <nav className="docs-pager" aria-label="Previous and next topics">
            {before ? (
              <Link to={href(before.slug)} className="docs-pager-prev">
                <span className="docs-pager-k"><span aria-hidden="true">← </span>Previous</span>{" "}
                <span className="docs-pager-t">{before.title}</span>
              </Link>
            ) : <span />}
            {after ? (
              <Link to={href(after.slug)} className="docs-pager-next">
                <span className="docs-pager-k">Next<span aria-hidden="true"> →</span></span>{" "}
                <span className="docs-pager-t">{after.title}</span>
              </Link>
            ) : null}
          </nav>
        </article>
      </div>
    </DocsBaseContext>
  );
}

/** On equity, tax and legal topics: what the page is, and who gives advice. */
function GeneralInformation() {
  return (
    <Banner kind="info" title="General information, not advice">
      This page explains common terms and practices in general. It isn't legal, tax or financial advice. Rules differ from country
      to country and change over time, and a company's own documents decide what applies. For advice about a specific situation,
      talk to the company's counsel or a tax advisor.
    </Banner>
  );
}
