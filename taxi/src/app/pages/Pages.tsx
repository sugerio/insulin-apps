import type { ReactNode } from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty.tsx";
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

const homeLink = <Button asChild variant="outline"><Link to="/returns">Go to your returns</Link></Button>;

export function NotFoundPage() {
  return <MessagePage title="Page not found" action={homeLink}><p>There is nothing at this address.</p></MessagePage>;
}

/** Shown when the server doesn't know who is using the app (a 401): opened outside Insulin Apps, or the session ended. */
export function OpenFromConsolePage({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="grid min-h-svh place-items-center p-6">
      <Card className="w-full max-w-md" role="alert">
        <CardHeader>
          <BrandMark size={40} />
          <CardTitle><h1 className="text-xl font-semibold tracking-tight">Open this app from Insulin Apps</h1></CardTitle>
          <CardDescription>Taxi learns who you are from Insulin Apps. Sign in there and open Taxi.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Already signed in? Your session may have ended: reload, then open the app again.</p>
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
