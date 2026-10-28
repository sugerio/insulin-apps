import { useEffect } from "react";

export const APP_NAME = "Cap Table";

/** Sets `document.title` to "<title> · Cap Table" while the calling screen is shown. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}
