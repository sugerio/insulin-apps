import { ApiError, type ClientErrorCode } from "../api/client.ts";

export type ErrorMessages = Partial<Record<ClientErrorCode, string>>;

/**
 * A sentence for a failed request. Server messages are shown where they carry specific, safe context, including
 * validation, not-found, conflict and inactive-company errors; other codes get a fixed message.
 */
export function describeError(error: unknown, messages: ErrorMessages = {}): string {
  if (error instanceof ApiError) {
    const custom = messages[error.code];
    if (custom) return custom;
    switch (error.code) {
      case "network_error":
        return "Couldn't reach Cap Table. Check your connection and try again.";
      case "unauthenticated":
        return "Open this app from the Insulin console to continue.";
      case "forbidden":
        if (error.reason === "org_inactive") return error.message || "This company can't be changed right now.";
        return "You don't have permission to do that.";
      case "unavailable":
        return "Cap Table is briefly unavailable. Nothing was changed. Try again in a moment.";
      case "internal":
        return error.message || "Something went wrong on the server. Try again in a moment.";
      case "validation_failed":
      case "not_found":
      case "conflict":
        return error.message;
      default:
        return error.message || "Something went wrong. Try again.";
    }
  }
  return "Something went wrong. Try again.";
}

export function isApiError(error: unknown, code?: ClientErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}
