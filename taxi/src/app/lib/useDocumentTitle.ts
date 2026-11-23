import { useEffect } from "react";

export const APP_NAME = "Taxi";

/** Sets `document.title` to "<title> · Taxi" while the calling screen is shown. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}
