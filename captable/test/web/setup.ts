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
