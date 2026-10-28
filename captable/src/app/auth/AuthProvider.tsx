import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "#shared";
import { ApiError, onUnauthorized } from "../api/client.ts";
import { apiRequest } from "../api/request.ts";

type Me = api.MeResponse;

// Who is using the app comes from the Insulin console: the server reads the console's identity on every request and
// answers `/api/me` with the user, their role and what it lets them do here. There is no sign-in or sign-out of the
// app's own; a 401 (on /api/me or any later call) means the app was opened outside the console.

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; me: Me }
  | { status: "unauthenticated" }
  | { status: "error"; error: unknown };
interface AuthValue {
  state: AuthState;
  me: Me | null;
  refresh(): Promise<void>;
}
const AuthContext = createContext<AuthValue | null>(null);

export function getMe(signal?: AbortSignal): Promise<Me> {
  return apiRequest(api.routes.getMe, { signal });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const me = await getMe(signal);
      setState({ status: "authenticated", me });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState(error instanceof ApiError && error.status === 401 ? { status: "unauthenticated" } : { status: "error", error });
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => onUnauthorized(() => setState({ status: "unauthenticated" })), []);
  const refresh = useCallback(() => load(), [load]);
  const value = useMemo<AuthValue>(
    () => ({ state, me: state.status === "authenticated" ? state.me : null, refresh }),
    [state, refresh],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
export function useMe(): Me {
  const me = useAuth().me;
  if (!me) throw new Error("useMe requires an authenticated route");
  return me;
}
