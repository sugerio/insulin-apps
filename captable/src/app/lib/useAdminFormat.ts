import { useMemo } from "react";
import { api } from "#shared";
import { useMe } from "../auth/AuthProvider.tsx";
import { createFormatter, type Formatter } from "./format.ts";

export function useAdminFormat(): Formatter {
  const me = useMe();
  return useMemo(
    () => createFormatter(api.DEFAULT_ORG_SETTINGS.display, undefined, new Date(me.serverTime).toISOString().slice(0, 10)),
    [me.serverTime],
  );
}
