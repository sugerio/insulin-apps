// The member pages' addresses, without a router library: history.pushState and popstate. The app runs in the console's
// sandboxed iframe too, where only same-document navigation is allowed, which is all this does.
import React from 'react'

const CHANGE = 'esign:navigate'

function currentPath(): string {
  return typeof window === 'undefined' || !window.location ? '/' : window.location.pathname || '/'
}

function currentSearch(): string {
  return typeof window === 'undefined' || !window.location ? '' : window.location.search || ''
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  window.addEventListener('popstate', listener)
  window.addEventListener(CHANGE, listener)
  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener(CHANGE, listener)
  }
}

/** The current path; the component re-renders when it changes. */
export function usePath(): string {
  return React.useSyncExternalStore(subscribe, currentPath, () => '/')
}

/** The current query (`?status=completed`, or ''); the component re-renders when it changes. */
export function useSearch(): string {
  return React.useSyncExternalStore(subscribe, currentSearch, () => '')
}

export function navigate(path: string): void {
  if (typeof window === 'undefined') return
  try { window.history.pushState(null, '', path) } catch { /* a test window without history */ }
  try { window.dispatchEvent(new Event(CHANGE)) } catch { /* a test window without events */ }
  // A new page starts at its top; a link to a section (#id) scrolls to it once it has rendered.
  const hash = path.includes('#') ? path.slice(path.indexOf('#') + 1) : ''
  try {
    if (!hash) window.scrollTo?.(0, 0)
    else setTimeout(() => { try { document.getElementById(decodeURIComponent(hash))?.scrollIntoView?.({ block: 'start' }) } catch { /* a malformed escape */ } }, 0)
  } catch { /* not a real window */ }
}

/** An in-app link: a real <a href> (open in a new tab works), navigated in place on a plain click. */
export function Link({ to, children, className, ...props }: { to: string; children?: React.ReactNode; className?: string } & Omit<React.ComponentProps<'a'>, 'href'>) {
  return React.createElement('a', {
    href: to,
    className,
    ...props,
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigate(to)
    },
  }, children)
}
