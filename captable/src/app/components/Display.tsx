import { createContext, useContext } from "react";
import type { Formatter } from "../lib/format.ts";

// What a view needs to show numbers and dates, whichever shell it sits in: the formatter (decimals, time zone) and the
// org's today (deadlines count from it, the vesting chart marks it). The admin workspace provides it from the org's
// settings; the holder portal from its own defaults and the overview's as-of date.

export interface Display {
  format: Formatter;
  today: string;
}

export const DisplayContext = createContext<Display | null>(null);

export function useDisplay(): Display {
  const value = useContext(DisplayContext);
  if (!value) throw new Error("useDisplay must be used inside OrgWorkspace or the portal");
  return value;
}
