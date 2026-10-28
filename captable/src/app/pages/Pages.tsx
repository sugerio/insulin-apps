import { Link, isRouteErrorResponse, useRouteError } from "react-router";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasAdminAccess } from "../auth/access.ts";
import { BrandMark } from "../components/BrandMark.tsx";

/** An address the app has no page for, in the workspace or anywhere else outside the holder's portal. */
export function NotFoundPage() {
  return <section className="empty"><h1>Page not found</h1><p>There is nothing at this address.</p><Link to="/">Go home</Link></section>;
}
export function NoAccessPage() {
  const { me } = useAuth();
  // A holder whose access ended mid-session lands here too (a holding past its window): the page says which console
  // account the app sees, the one thing an equity team needs to connect it to a stakeholder record.
  const hasAccess = me !== null && (hasAdminAccess(me) || me.portal.matches.length > 0);
  return (
    <section className="empty">
      <h1>No access</h1>
      <p>You don't have access to this page.</p>
      {me && !hasAccess ? (
        <p>
          {me.user.email ? <>Your console account (<b>{me.user.email}</b>) doesn't match any stakeholder of {me.company?.displayName ?? "this company"}. </> : null}
          If you hold equity and think you should have access, ask the company's equity team to add your e-mail address to your stakeholder record.
        </p>
      ) : (
        <p>If you hold equity and think you should have access, contact your company's equity team.</p>
      )}
      {hasAccess ? <p><Link to="/">Go to your home page</Link></p> : null}
    </section>
  );
}
/**
 * Shown when the server doesn't know who is using the app (a 401): the app was opened outside the Insulin console, or
 * the console's session ended. The app runs in the console's sandboxed frame, so there is no link out, only a retry.
 */
export function OpenFromConsolePage({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="center-page">
      <div className="card console-card" role="alert">
        <BrandMark size={40} />
        <h1>Open this app from the Insulin console</h1>
        <p>Cap Table learns who you are from the Insulin console. Open the console and choose this app there to see the cap table or your holdings.</p>
        <p className="small">Already in the console? Your session may have ended: reload the console, then open the app again.</p>
        {onRetry ? <button type="button" className="btn btn-compact" onClick={onRetry}>Try again</button> : null}
      </div>
    </div>
  );
}
export function RouteErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return <section className="empty"><h1>{notFound ? "Page not found" : "Something went wrong"}</h1>
    <p>{notFound ? "There is nothing at this address." : "Reload the page and try again."}</p><Link to="/">Go home</Link></section>;
}
