import { Component, type ReactNode, useEffect } from 'react'

/**
 * The AppBuilder's connection to the app in its preview: console, network, error
 * and hot-update reports, the element inspector, the database inspector and
 * screenshots. Publishing replaces this file with a passthrough, so none of it
 * ships in a published app.
 *
 * The preview is never reloaded for an edit: the dev server hot-updates the
 * open page (or reloads it itself when an update cannot apply), and this
 * bridge reports what each update did, the same way it reports the page's own
 * console.
 */

type AppBuilderMessage = {
  type?: string
  renderNonce?: number
  requestId?: number
  elementIds?: string[]
  enabled?: boolean
  theme?: string
  region?: { x: number; y: number; width: number; height: number }
}

type Html2Canvas = (element: HTMLElement, options: object) => Promise<HTMLCanvasElement>

function readable(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** A console call as one line of text, `%s`/`%o`-style substitutions applied. */
function consoleText(args: unknown[]): string {
  const [first, ...rest] = args
  if (typeof first !== 'string' || !/%[sdifoOc]/.test(first)) return args.map(readable).join(' ')
  const text = first.replace(/%[sdifoOc]/g, (directive) => {
    if (rest.length === 0) return directive
    const value = rest.shift()
    return directive === '%c' ? '' : readable(value)
  })
  return [text, ...rest.map(readable)].join(' ')
}

const PARENT_ORIGIN_KEY = 'suger-app-builder:parent-origin'

/**
 * The origins the AppBuilder is served from: the consoles and their Cloudflare
 * Pages branch previews. A page that frames someone else's running preview can
 * put any `expectedParent` in the URL; trusting it would let that page drive the
 * preview and receive its database rows and telemetry, so only these are accepted.
 */
const APP_BUILDER_ORIGINS = new Set([
  'https://console.suger.io',
  'https://console.stag.suger.io',
  'https://console.dev.suger.io',
  'http://localhost:3000',
])

/** A console Pages preview: one branch label (`my-branch.…`) or the project root, `dev` or `stag`. */
const APP_BUILDER_PAGES_ORIGIN =
  /^https:\/\/(?:[a-z0-9-]+\.)?suger-console-ui-(?:dev|stag)\.pages\.dev$/

/** The claimed origin, or null when it is not a provable AppBuilder origin. */
function acceptParentOrigin(candidate: string | null): string | null {
  if (candidate === null) return null
  if (!APP_BUILDER_ORIGINS.has(candidate) && !APP_BUILDER_PAGES_ORIGIN.test(candidate)) return null
  // Chromium exposes the real embedding origin; Firefox does not. Where it is
  // exposed, a claim that disagrees with it is a frame the AppBuilder did not make.
  const ancestorOrigins: DOMStringList | undefined = window.location.ancestorOrigins
  const embedded = ancestorOrigins?.[0]
  if (embedded !== undefined && embedded !== candidate) return null
  return candidate
}

/**
 * The AppBuilder's origin, from the `expectedParent` query it opens the page with.
 * The tab remembers it: once the app navigates, the address no longer carries the
 * query, and the dev server's own reloads load that address. Null means no
 * AppBuilder was proven, and the bridge stays inert rather than trusting whoever
 * framed it.
 */
function readParentOrigin(): string | null {
  const expected = new URLSearchParams(window.location.search).get('expectedParent')
  let remembered: string | null = null
  if (expected === null) {
    try {
      remembered = sessionStorage.getItem(PARENT_ORIGIN_KEY)
    } catch {
      // Storage can be refused to the frame; then only the query is left.
    }
  }
  const accepted = acceptParentOrigin(expected ?? remembered)
  try {
    if (expected !== null && accepted !== null) sessionStorage.setItem(PARENT_ORIGIN_KEY, accepted)
  } catch {
    // Storage can be refused to the frame; the parent is still known for this load.
  }
  return accepted
}

const parentOrigin = readParentOrigin()

function postToAppBuilder(message: Record<string, unknown>) {
  if (parentOrigin === null) return
  window.parent.postMessage(message, parentOrigin)
}

/**
 * Reports made before the app mounts (its modules loading, its first render)
 * wait until the AppBuilder has heard the page is up: that is when it starts this
 * page's log afresh.
 */
let beforeReady: Array<Record<string, unknown>> | null = []

function report(message: Record<string, unknown>) {
  if (beforeReady) beforeReady.push(message)
  else postToAppBuilder(message)
}

/**
 * Once per page load: a second SANDBOX_READY would start the page's log over,
 * dropping an error that was reported before the app mounted.
 */
function pageReady() {
  if (!beforeReady) return
  postToAppBuilder({ type: 'SANDBOX_READY' })
  const queued = beforeReady
  beforeReady = null
  for (const message of queued) postToAppBuilder(message)
}

function log(level: 'log' | 'warn' | 'error', message: string) {
  report({ type: 'RUNTIME_LOG', level, message: message.slice(0, 4000), timestamp: Date.now() })
}

function serializeElement(element: Element) {
  const id = (element as HTMLElement).dataset.sugerId
  if (!id) return null
  return {
    id,
    tag: element.tagName.toLowerCase(),
    text: (element.textContent ?? '').trim().slice(0, 500),
    attributes: Object.fromEntries(
      [...element.attributes]
        .filter((attribute) => attribute.name !== 'style')
        .map((attribute) => [attribute.name, attribute.value]),
    ),
    rect: element.getBoundingClientRect().toJSON(),
  }
}

function inspectElements(elementIds: string[]) {
  return elementIds.map((id) => {
    const element = document.querySelector(`[data-suger-id="${CSS.escape(id)}"]`)
    const serialized = element ? serializeElement(element) : null
    return serialized ? { ...serialized, found: true } : { id, found: false }
  })
}

function inspectRegion(region: { x: number; y: number; width: number; height: number }) {
  const overlap = (element: Element) => {
    const rect = element.getBoundingClientRect()
    const width = Math.min(rect.right, region.x + region.width) - Math.max(rect.left, region.x)
    const height = Math.min(rect.bottom, region.y + region.height) - Math.max(rect.top, region.y)
    return Math.max(0, width) * Math.max(0, height)
  }
  return [...document.querySelectorAll('[data-suger-id]')]
    .map((element) => ({ element, area: overlap(element) }))
    .filter(({ area }) => area > 0)
    .sort((left, right) => right.area - left.area)
    .slice(0, 12)
    .map(({ element }) => serializeElement(element))
    .filter((element) => element !== null)
}

function onInspectorClick(event: MouseEvent) {
  const target = (event.target as Element | null)?.closest?.('[data-suger-id]')
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  postToAppBuilder({
    type: 'ELEMENT_CLICKED',
    element: serializeElement(target),
    multi: event.metaKey || event.ctrlKey || event.shiftKey,
  })
}

function setInspector(enabled: boolean) {
  document.documentElement.classList.toggle('suger-inspector', enabled)
  if (enabled) document.addEventListener('click', onInspectorClick, true)
  else document.removeEventListener('click', onInspectorClick, true)
}

/** The AppBuilder's screenshot renderer, loaded on first use (the preview serves it). */
async function html2canvas(): Promise<Html2Canvas> {
  const loaded = () => (window as { html2canvas?: Html2Canvas }).html2canvas
  if (!loaded()) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/vendor/html2canvas-1.4.1.js'
      script.onload = resolve
      script.onerror = () => reject(new Error('Screenshot renderer is unavailable'))
      document.head.append(script)
    })
  }
  const render = loaded()
  if (!render) throw new Error('Screenshot renderer is unavailable')
  return render
}

async function inspectDatabase() {
  const response = await fetch('/api/__suger/app-builder/data', { cache: 'no-store' })
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === 'string' ? payload.error : `Database inspector returned ${response.status}`,
    )
  }
  return payload
}

async function onAppBuilderMessage(message: AppBuilderMessage) {
  switch (message.type) {
    case 'SET_THEME':
      document.documentElement.classList.toggle('dark', message.theme === 'dark')
      break
    case 'SET_INSPECTOR':
      setInspector(Boolean(message.enabled))
      break
    case 'INSPECT_ELEMENT_DATA':
      postToAppBuilder({
        type: 'INSPECT_ELEMENT_DATA_RESULT',
        requestId: message.requestId,
        results: inspectElements(message.elementIds ?? []),
      })
      break
    case 'INSPECT_REGION':
      postToAppBuilder({
        type: 'INSPECT_REGION_RESULT',
        requestId: message.requestId,
        results: message.region ? inspectRegion(message.region) : [],
      })
      break
    case 'INSPECT_DATABASE':
      // Keep the wire identifier compatible with already-open console tabs.
      try {
        const snapshot = await inspectDatabase()
        postToAppBuilder({ type: 'STUDIO_DATABASE_RESULT', requestId: message.requestId, snapshot })
      } catch (error) {
        postToAppBuilder({ type: 'STUDIO_DATABASE_RESULT', requestId: message.requestId, error: readable(error) })
      }
      break
    case 'CAPTURE_SCREENSHOT':
      try {
        const root = document.getElementById('suger-app-root')
        if (!root) throw new Error('Preview root is unavailable')
        const canvas = await (await html2canvas())(root, {
          backgroundColor: null,
          logging: false,
          useCORS: false,
          allowTaint: false,
        })
        postToAppBuilder({
          type: 'SCREENSHOT_RESULT',
          image: canvas.toDataURL('image/png'),
          renderNonce: message.renderNonce,
        })
      } catch (error) {
        postToAppBuilder({ type: 'SCREENSHOT_ERROR', error: readable(error), renderNonce: message.renderNonce })
      }
      break
  }
}

function onParentMessage(event: MessageEvent) {
  if (parentOrigin === null || event.source !== window.parent || event.origin !== parentOrigin || !event.data)
    return
  void onAppBuilderMessage(event.data as AppBuilderMessage)
}

/** A hot update is being applied; an error logged meanwhile means it failed. */
let hotUpdate: { failed: boolean } | null = null

/** Console calls, fetch metadata and uncaught errors. Network bodies belong to Zero's bounded observer. */
function observePage(): () => void {
  const original = { log: console.log, warn: console.warn, error: console.error, fetch: window.fetch }
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      original[level].apply(console, args)
      if (level === 'error' && hotUpdate) hotUpdate.failed = true
      log(level, consoleText(args))
    }
  }
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = Date.now()
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const reportRequest = (status: number, errorText?: string) =>
      report({
        type: 'RUNTIME_NETWORK',
        url,
        method,
        status,
        body: '',
        ...(errorText === undefined ? {} : { errorText }),
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      })
    try {
      const response = await original.fetch.call(window, input, init)
      reportRequest(response.status)
      return response
    } catch (error) {
      reportRequest(0, 'Network request failed')
      throw error
    }
  }
  // An uncaught error before the app mounts may be why it never will (a module
  // that throws while it loads), so the page says it is up now and sends the
  // error with what waited for that.
  const onError = (event: ErrorEvent) => {
    log('error', event.message)
    pageReady()
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    log('error', readable(event.reason))
    pageReady()
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    Object.assign(console, { log: original.log, warn: original.warn, error: original.error })
    window.fetch = original.fetch
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

type ViteError = {
  message: string
  id?: string
  frame?: string
  plugin?: string
  loc?: { file?: string; line: number; column: number }
}

/** A dev-server error (a module that does not compile or resolve), as the console would show it. */
function viteErrorText(error: ViteError): string {
  const where = error.loc
    ? `${error.loc.file ?? error.id ?? ''}:${error.loc.line}:${error.loc.column}`
    : error.id
  return [
    `[vite] ${error.plugin ? `[plugin ${error.plugin}] ` : ''}${error.message}`,
    where && !error.message.includes(where) ? `at ${where}` : '',
    error.frame ?? '',
  ]
    .filter(Boolean)
    .join('\n')
}

// From the first module the page loads: errors in the app's own modules and
// its first render are reported too.
const restorePage = observePage()
// The AppBuilder's requests are answered from then on too, not only once the app
// mounts: a page whose app never mounts still says it is up when an error stops it.
window.addEventListener('message', onParentMessage)

if (import.meta.hot) {
  // Every edit reaches the page as a hot update: report what each one did.
  import.meta.hot.on('vite:beforeUpdate', () => {
    hotUpdate = { failed: false }
  })
  import.meta.hot.on('vite:afterUpdate', (payload) => {
    const failed = hotUpdate?.failed ?? false
    hotUpdate = null
    if (!failed) log('log', `[vite] hot updated: ${payload.updates.map((update) => update.path).join(', ')}`)
  })
  // A module that does not compile or resolve (Vite shows its overlay).
  import.meta.hot.on('vite:error', (payload) => log('error', viteErrorText(payload.err)))
  import.meta.hot.dispose(() => {
    restorePage()
    window.removeEventListener('message', onParentMessage)
  })
}

class PreviewErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; error: unknown }> {
  state: { failed: boolean; error: unknown } = { failed: false, error: null }

  // React reports the error itself (console.error), and the next hot update of
  // the component that threw renders it again.
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div
        role="alert"
        style={{ padding: 24, font: '13px/1.5 ui-monospace, monospace', color: '#b91c1c', whiteSpace: 'pre-wrap' }}
      >
        {`The app crashed while rendering:\n${readable(this.state.error)}`}
      </div>
    )
  }
}

/** Wraps the app (src/main.tsx). Fixed template infrastructure; the app lives in src/app. */
export function SugerAppBuilderRuntime({ children }: { children: ReactNode }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') postToAppBuilder({ type: 'INSPECTOR_ESCAPE' })
    }
    window.addEventListener('keydown', onKeyDown)
    pageReady()

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      setInspector(false)
    }
  }, [])

  return (
    <div id="suger-app-root">
      <PreviewErrorBoundary>{children}</PreviewErrorBoundary>
    </div>
  )
}
