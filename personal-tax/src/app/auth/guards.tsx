import { Outlet } from "react-router";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { OpenFromConsolePage } from "../pages/Pages.tsx";
import { useAuth } from "./AuthProvider.tsx";

/** Every page waits for `/api/me`; without the platform's identity, every page gives way to the one message that helps. */
export function RequireAuth() {
  const { state, refresh } = useAuth();
  if (state.status === "loading") {
    return (
      <div className="grid min-h-svh place-items-center p-6 text-sm text-muted-foreground" role="status">
        <span className="flex items-center gap-2"><Spinner />Loading Personal Tax…</span>
      </div>
    );
  }
  if (state.status === "unauthenticated") return <OpenFromConsolePage onRetry={() => void refresh()} />;
  if (state.status === "error") {
    return (
      <div className="grid min-h-svh place-items-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle><h1 className="text-lg font-semibold">Couldn't load Personal Tax</h1></CardTitle>
            <CardDescription>Something went wrong while loading your access. Try again in a moment.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void refresh()}>Try again</Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <Outlet />;
}

/** Above every page while the app runs without the platform's identity (the local preview). */
export function PreviewStrip() {
  return (
    <div className="border-b bg-muted px-5 py-2 text-sm text-muted-foreground" role="status">
      <b>Preview mode.</b> You're using the app as a stand-in owner, with no Insulin Apps account. Once published, everyone opens it with their own role.
    </div>
  );
}
