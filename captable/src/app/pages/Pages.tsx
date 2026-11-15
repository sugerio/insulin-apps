import type { ReactNode } from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasAdminAccess } from "../auth/access.ts";
import { BrandMark } from "../components/BrandMark.tsx";

/** A page that only says something: a heading, its explanation and the way on. */
function MessagePage({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Empty className="min-h-[60vh]">
      <EmptyHeader className="max-w-lg">
        <EmptyTitle><h1 className="text-2xl font-semibold tracking-tight">{title}</h1></EmptyTitle>
        <EmptyDescription className="flex flex-col gap-2">{children}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

const homeLink = <Button asChild variant="outline"><Link to="/">Go home</Link></Button>;

/** An address the app has no page for, in the workspace or anywhere else outside the holder's portal. */
export function NotFoundPage() {
  return <MessagePage title="Page not found" action={homeLink}><p>There is nothing at this address.</p></MessagePage>;
}
export function NoAccessPage() {
  const { me } = useAuth();
  // A holder whose access ended mid-session lands here too (a holding past its window): the page says which console
  // account the app sees, the one thing an equity team needs to connect it to a stakeholder record.
  const hasAccess = me !== null && (hasAdminAccess(me) || me.portal.matches.length > 0);
  return (
    <MessagePage title="No access" action={hasAccess ? <Button asChild variant="outline"><Link to="/">Go to your home page</Link></Button> : undefined}>
      <p>You don't have access to this page.</p>
      {me && !hasAccess ? (
        <p>
          {me.user.email ? <>Your console account (<b>{me.user.email}</b>) doesn't match any stakeholder of {me.company?.displayName ?? "this company"}. </> : null}
          If you hold equity and think you should have access, ask the company's equity team to add your e-mail address to your stakeholder record.
        </p>
      ) : (
        <p>If you hold equity and think you should have access, contact your company's equity team.</p>
      )}
    </MessagePage>
  );
}
/**
 * Shown when the server doesn't know who is using the app (a 401): the app was opened outside the Insulin console, or
 * the console's session ended. The app runs in the console's sandboxed frame, so there is no link out, only a retry.
 */
export function OpenFromConsolePage({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="grid min-h-svh place-items-center p-6">
      <Card className="w-full max-w-md" role="alert">
        <CardHeader>
          <BrandMark size={40} />
          <CardTitle><h1 className="text-xl font-semibold tracking-tight">Open this app from the Insulin console</h1></CardTitle>
          <CardDescription>
            Cap Table learns who you are from the Insulin console. Open the console and choose this app there to see the cap table or your holdings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Already in the console? Your session may have ended: reload the console, then open the app again.</p>
        </CardContent>
        {onRetry ? <CardFooter><Button type="button" variant="outline" onClick={onRetry}>Try again</Button></CardFooter> : null}
      </Card>
    </div>
  );
}
export function RouteErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <MessagePage title={notFound ? "Page not found" : "Something went wrong"} action={homeLink}>
      <p>{notFound ? "There is nothing at this address." : "Reload the page and try again."}</p>
    </MessagePage>
  );
}
