import Anthropic from "@anthropic-ai/sdk";
import { integrationBaseUrl, integrationFetch } from "@fours/app/server";
import { claudeReader, unavailableReader, type SlipReader } from "./reader.ts";

// Where AI reading comes from. On Insulin Apps: the organization's stored credential under the key `anthropic`
// (Settings › Integrations, base URL https://api.anthropic.com, sent as the named header x-api-key), through the
// platform's integration proxy, so the app never sees the key. In the local dev server only: ANTHROPIC_API_KEY from the
// environment, when it is set. Anywhere else, each file says AI reading isn't set up.

export const INTEGRATION_KEY = "anthropic";

export function platformReader(orgId: string): SlipReader {
  const localKey = import.meta.env.DEV && typeof process !== "undefined" ? process.env.ANTHROPIC_API_KEY : undefined;
  if (localKey) return claudeReader(new Anthropic({ apiKey: localKey, maxRetries: 1, timeout: 120_000 }));
  try {
    // Throws where the platform's integration proxy isn't available (the local dev server, tests).
    integrationBaseUrl(INTEGRATION_KEY);
  } catch {
    return unavailableReader(
      "Files can't be read here yet. On Insulin Apps, an admin adds the organization's Anthropic credential (Settings › Integrations, key anthropic).",
    );
  }
  return claudeReader(
    new Anthropic({
      // The proxy replaces this header with the stored secret; the app never holds the key.
      apiKey: "added-by-insulin-apps",
      baseURL: "https://api.anthropic.com",
      fetch: integrationFetch(INTEGRATION_KEY),
      defaultHeaders: { "x-suger-organization-id": orgId },
      maxRetries: 1,
      timeout: 120_000,
    }),
  );
}
