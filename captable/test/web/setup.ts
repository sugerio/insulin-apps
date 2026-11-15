import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Imported first by every web test (the shared vitest config has no setup file per project). Page tests render the
// whole app; on a busy CI runner a page can take longer than 5 s to settle, and only a failing wait is slowed by this.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 10_000 });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// What jsdom lacks and shadcn/ui's Radix parts call: sizing, the pointer and scroll methods, and the narrow-screen
// query of the sidebar (jsdom's screen is wide). Source-only tests run without a DOM.
if (typeof Element !== "undefined") {
  if (typeof globalThis.ResizeObserver !== "function") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
