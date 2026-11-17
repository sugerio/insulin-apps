import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { routes, type Me } from "#shared";
import { ApiError, apiRequest, onUnauthorized } from "../api/client.ts";

// Who is using the app comes from the platform: the server reads its identity on every request and answers `/api/me`
// with the person, their role and permissions. There is no sign-in of the app's own; a 401 (on /api/me or any later
// call) means the app was opened outside Insulin Apps.

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; me: Me }
  | { status: "unauthenticated" }
  | { status: "error"; error: unknown };
interface AuthValue {
  state: AuthState;
  refresh(): Promise<void>;
}
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setState({ status: "authenticated", me: await apiRequest(routes.getMe, { signal }) });
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
  const value = useMemo<AuthValue>(() => ({ state, refresh: () => load() }), [state, load]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== "authenticated") throw new Error("useMe requires an authenticated route");
  return state.me;
}
