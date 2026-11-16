import { Navigate, Outlet, useMatches, useParams } from "react-router";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useAuth, useMe } from "./AuthProvider.tsx";
import { hasAdminAccess } from "./access.ts";
import { OpenFromConsolePage } from "../pages/Pages.tsx";

/** The route `handle` of the app's shell, which shows the preview strip in its own column. */
export interface ShellHandle {
  shell: true;
}

export function RequireAuth() {
  const { state, refresh } = useAuth();
  const inShell = useMatches().some((match) => (match.handle as Partial<ShellHandle> | undefined)?.shell === true);
  if (state.status === "loading") {
    return (
      <div className="grid min-h-svh place-items-center p-6 text-sm text-muted-foreground" role="status">
        <span className="flex items-center gap-2"><Spinner />Loading Cap Table…</span>
      </div>
    );
  }
  // Signing in is the console's: without its identity every page gives way to the one message that helps.
  if (state.status === "unauthenticated") return <OpenFromConsolePage onRetry={() => void refresh()} />;
  if (state.status === "error") {
    return (
      <div className="grid min-h-svh place-items-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle><h1 className="text-lg font-semibold">Couldn’t load Cap Table</h1></CardTitle>
            <CardDescription>Something went wrong while loading your access. Try again in a moment.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void refresh()}>Try again</Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  return (
    <>
      {state.me.preview && !inShell ? <PreviewStrip /> : null}
      <Outlet />
    </>
  );
}

/**
 * Above every page, setup included, while the app runs without a console identity (the console's preview). Inside the
 * shell it heads the page's column, beside the navigation.
 */
export function PreviewStrip() {
  return (
    <div className="border-b bg-muted px-5 py-2 text-sm text-muted-foreground" role="status">
      <b>Preview mode.</b> You're using the app as a stand-in owner, with no console account. Once published, everyone opens it from the Insulin console with their own role.
    </div>
  );
}

// Every refusal lands on the no-access page; an app whose company isn't set up yet lands on the setup page.

export function RequireOrgAccess() {
  const { orgId } = useParams();
  const me = useMe();
  if (me.company === null) return <Navigate to={me.companyExists ? "/no-access" : "/setup"} replace />;
  if (!hasAdminAccess(me)) return <Navigate to="/no-access" replace />;
  // One company per Insulin organization: another id is foreign or retired, so an administrator goes home.
  return me.company.id === orgId ? <Outlet /> : <Navigate to="/" replace />;
}

export function RequirePortal() {
  const { orgId } = useParams();
  const { matches } = useMe().portal;
  // Holder access is recomputed on every request: one that has ended, or another company's portfolio, leads to the
  // no-access page.
  const allowed = matches.length > 0 && (orgId === undefined || matches.some((match) => match.orgId === orgId));
  return allowed ? <Outlet /> : <Navigate to="/no-access" replace />;
}
