import { useCallback, useEffect } from "react";
import { useBlocker } from "react-router";
import { unsettledWrites } from "../lib/unsettled.ts";
import { useToast } from "./Toast.tsx";

// The app-wide stop for a write whose outcome isn't known yet (lib/unsettled): leaving the page would drop the body and
// the key that a retry must resend, so in-app navigation is held back with a word on why. A router supports one blocker,
// so this is the only one; it reads the count when a navigation starts, so a write that just succeeded can move on to
// its result. There is deliberately no browser "leave this page?" prompt: the app runs in the console's frame, where a
// native dialog would interrupt the console itself. After a reload mid-write, the record shows whether it was written.

export function UnsettledGuard() {
  const toast = useToast();
  const shouldBlock = useCallback(() => unsettledWrites() > 0, []);
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    blocker.reset();
    toast({ tone: "warn", message: "A write's outcome isn't known yet. Try again, or Check what was recorded, before you leave this page." });
  }, [blocker, toast]);
  return null;
}
