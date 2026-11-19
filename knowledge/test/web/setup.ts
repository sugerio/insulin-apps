import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Imported first by every web test, as Cap Table's are. Page tests render the whole app against the in-memory engine;
// on a busy machine a page can take longer than the default to settle.
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 10_000 })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  try {
    window.localStorage.clear()
  } catch {
    // Storage can be off.
  }
})

// What jsdom lacks and shadcn/ui's Radix parts call: sizing, the pointer and scroll methods, and the narrow-screen
// query of the sidebar (jsdom's screen is wide unless a test narrows it).
if (typeof Element !== 'undefined') {
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  window.matchMedia ??= (query: string) =>
    ({
      matches: /max-width:\s*(\d+)px/.test(query) ? window.innerWidth <= Number(/max-width:\s*(\d+)px/.exec(query)![1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}
