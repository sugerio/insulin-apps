import { useState, useSyncExternalStore } from "react";

// Where a step shows its return's estimate: in a column beside the step on a wide screen, unless the viewer collapsed
// it into the bar above the step. The choice is this browser's, kept across steps and reloads.

/** Wide enough for the app's navigation, the estimate column and a step's tables and amounts side by side. */
export const WIDE_QUERY = "(min-width: 1280px)";
export const ESTIMATE_COLUMN_KEY = "taxi-estimate-column";

/** Whether the screen matches a media query, following it as the window is resized. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Whether the estimate column is collapsed into the bar above the step, and a way to change it. */
export function useEstimateColumnCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  return [
    collapsed,
    (next) => {
      setCollapsed(next);
      try {
        window.localStorage.setItem(ESTIMATE_COLUMN_KEY, next ? "collapsed" : "expanded");
      } catch {
        // Storage can be off (a private window, blocked site data): the choice then lasts until the page is reloaded.
      }
    },
  ];
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(ESTIMATE_COLUMN_KEY) === "collapsed";
  } catch {
    return false;
  }
}
