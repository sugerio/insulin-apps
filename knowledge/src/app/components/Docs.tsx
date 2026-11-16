import { useContext, useEffect, useRef } from 'react'
import { Link, NavigationType, useLocation, useNavigationType } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'
import { PlatformAccountContext, publicDocsLink } from '../lib/platform.ts'
import { DocsBaseContext, type DocTopic } from '../pages/docs/parts.tsx'
import { DOC_TOPICS } from '../pages/docs/topics.ts'

// The in-app Docs, as Cap Table has them (captable/src/app/components/Docs.tsx): the topic list beside the topic, which
// opens with its title, the "On this page" list of its sections, and previous and next. Every heading has an id, so a
// section can be linked from another topic (`/docs/sharing-and-roles#keep-it-ready`). Following a link in the app moves
// the focus to where it leads: the topic's title, or the section it names. Loading the page leaves the focus where the
// browser put it, and only scrolls to the section the address names. Static content: nothing is fetched.

const GROUPS = [['app', 'Using Knowledge'], ['background', 'Background']] as const

/** A topic in the list: a row beside the topic on a wide screen, a pill above it on a narrow one. */
const TOPIC_LINK = cn(
  'block rounded-md px-2.5 py-1.5 text-sm text-foreground/80 hover:bg-accent hover:text-accent-foreground',
  'max-lg:rounded-full max-lg:border max-lg:bg-card max-lg:px-3 max-lg:py-1',
  'aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-accent-foreground',
)

/**
 * A heading or a glossary term a link lands on takes the focus, and shows it: the focus ring when the keyboard led
 * there, and an underline in the primary colour whichever way it was reached. Each stops below the header when
 * scrolled to.
 */
const FOCUS_LANDING = cn(
  "[&_[tabindex='-1']:focus-visible]:rounded-sm [&_[tabindex='-1']:focus-visible]:outline-2 [&_[tabindex='-1']:focus-visible]:outline-offset-4 [&_[tabindex='-1']:focus-visible]:outline-ring",
  "[&_:is(h2,h3,dt)[tabindex='-1']:focus]:text-primary [&_:is(h2,h3,dt)[tabindex='-1']:focus]:underline [&_:is(h2,h3,dt)[tabindex='-1']:focus]:decoration-2 [&_:is(h2,h3,dt)[tabindex='-1']:focus]:underline-offset-4",
  '[&_:is(h1,h2,h3,dt)]:scroll-mt-20',
)

/** A topic's text: comfortable reading, lists with their markers, bold that stands out. */
const READING = cn(
  'text-[0.9375rem] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]',
  '[&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li+li]:mt-1.5',
  '[&_b]:font-semibold [&_b]:text-foreground [&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-foreground',
)

/** The id an address's "#…" names (a malformed escape is taken as it is, never thrown). */
function hashId(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return hash.slice(1)
  }
}

export function Docs({ base, topic }: { base: string; topic: DocTopic }) {
  const location = useLocation()
  const layout = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  // How the reader arrived: by a link in the app (a push), or by loading the page or being redirected on load.
  const navigationType = useNavigationType()
  const arrival = useRef<{ key: string; byLink: boolean } | null>(null)
  if (arrival.current === null) arrival.current = { key: location.key, byLink: navigationType === NavigationType.Push }
  useEffect(() => {
    const { key, byLink } = arrival.current!
    // Every move inside the docs moves the focus; on arrival, only a link in the app does.
    const moveFocus = location.key !== key || byLink
    const id = hashId(location.hash)
    const target = id ? document.getElementById(id) : null
    if (target && article.current?.contains(target)) {
      target.scrollIntoView?.({ block: 'start' })
      if (moveFocus) target.focus({ preventScroll: true })
      return
    }
    // A topic chosen further down the page starts at its top.
    if ((layout.current?.getBoundingClientRect().top ?? 0) < 0) window.scrollTo?.(0, 0)
    if (moveFocus) title.current?.focus({ preventScroll: true })
  }, [topic.slug, location.hash, location.key])

  const index = DOC_TOPICS.indexOf(topic)
  const before = DOC_TOPICS[index - 1]
  const after = DOC_TOPICS[index + 1]
  const href = (slug: string, section?: string) => `${base}/${slug}${section ? `#${section}` : ''}`
  const publicDocs = publicDocsLink(useContext(PlatformAccountContext))
  return (
    <DocsBaseContext value={base}>
      <div className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,880px)] lg:gap-6" ref={layout}>
        <nav className="flex min-w-0 flex-col gap-2.5 lg:sticky lg:top-6 lg:gap-4" aria-label="Docs topics">
          {GROUPS.map(([group, label]) => (
            <div key={group} className="flex flex-col gap-1">
              <p className="px-2.5 text-xs font-medium tracking-wide text-muted-foreground uppercase" id={`docs-group-${group}`}>{label}</p>
              <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5" aria-labelledby={`docs-group-${group}`}>
                {DOC_TOPICS.filter((item) => item.group === group).map((item) => (
                  <li key={item.slug}>
                    <Link to={href(item.slug)} className={TOPIC_LINK} aria-current={item.slug === topic.slug ? 'page' : undefined}>{item.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {publicDocs ? (
            <div className="flex flex-col gap-1">
              <p className="px-2.5 text-xs font-medium tracking-wide text-muted-foreground uppercase" id="docs-group-public">On the web</p>
              <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5" aria-labelledby="docs-group-public">
                <li><a className={TOPIC_LINK} href={publicDocs}>Public docs</a></li>
              </ul>
            </div>
          ) : null}
        </nav>
        <article className={cn('min-w-0 rounded-xl bg-card px-4 py-5 text-card-foreground ring-1 ring-foreground/10 sm:px-8 sm:py-7', FOCUS_LANDING)} ref={article}
          aria-labelledby="docs-title">
          <header className="mb-4">
            <h1 id="docs-title" ref={title} tabIndex={-1} className="text-2xl font-semibold tracking-tight sm:text-[1.625rem]">{topic.title}</h1>
            <p className="mt-1.5 text-[0.9375rem] text-muted-foreground">{topic.summary}</p>
          </header>
          <nav className="mb-1 rounded-lg border bg-muted/50 px-4 py-3" aria-label="On this page">
            <p className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase" aria-hidden="true">On this page</p>
            {topic.compactContents ? (
              <ul className="flex flex-wrap gap-1.5">
                {topic.sections.map((section) => (
                  <li key={section.id}>
                    <Button asChild variant="outline" size="sm" className="min-w-8 font-semibold"><Link to={href(topic.slug, section.id)}>{section.title}</Link></Button>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="list-disc gap-8 pl-5 text-sm sm:columns-2">
                {topic.sections.map((section) => (
                  <li key={section.id} className="break-inside-avoid py-0.5">
                    <Link className="underline-offset-4 hover:underline" to={href(topic.slug, section.id)}>{section.title}</Link>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          {topic.sections.map((section) => (
            <section key={section.id} className={READING}>
              <h2 id={section.id} tabIndex={-1} className="mt-7 mb-2.5 border-t pt-5 text-lg font-semibold text-foreground">{section.title}</h2>
              {section.body}
            </section>
          ))}
          <nav className="mt-8 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:justify-between" aria-label="Previous and next topics">
            {before ? (
              <Link to={href(before.slug)} className="flex flex-col gap-0.5 rounded-lg border px-3.5 py-2.5 hover:bg-accent sm:max-w-[48%]">
                <span className="text-xs text-muted-foreground"><span aria-hidden="true">← </span>Previous</span>{' '}
                <span className="font-medium text-primary">{before.title}</span>
              </Link>
            ) : <span />}
            {after ? (
              <Link to={href(after.slug)} className="flex flex-col gap-0.5 rounded-lg border px-3.5 py-2.5 hover:bg-accent sm:ml-auto sm:max-w-[48%] sm:text-right">
                <span className="text-xs text-muted-foreground">Next<span aria-hidden="true"> →</span></span>{' '}
                <span className="font-medium text-primary">{after.title}</span>
              </Link>
            ) : null}
          </nav>
        </article>
      </div>
    </DocsBaseContext>
  )
}
