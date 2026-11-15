import type { ReactNode } from "react";
import { Link } from "react-router";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { ErrorFocus } from "./ErrorFocus.tsx";
import { Banner } from "./Feedback.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";
import { Card } from "./Page.tsx";

// The frame of a write flow that has a page of its own (record a grant or an exercise, terminate, add or edit a
// stakeholder, record a 409A): who may open it, and the wizard header (close, title).

/**
 * Renders a write page only for those who may use it: read-only roles, everyone in an inactive company, and
 * an admin on their own holdings or record get the reason instead of a form. The server refuses these anyway; the page
 * doesn't offer what it would refuse.
 */
export function WriteGate({ own, back, children }: { own?: boolean; back: { to: string; label: string }; children: ReactNode }) {
  const { canWrite, writeRestriction } = useWorkspace();
  let reason: [title: string, text: string] | null = null;
  if (writeRestriction) reason = [writeRestriction.title, writeRestriction.text];
  else if (!canWrite) reason = ["You have read-only access", "Your role can view and export but not record changes. An owner, admin or editor can record this."];
  else if (own) reason = ["This is your own record", "Admins never record writes on their own holdings or stakeholder record — another admin must. The rule is enforced on the server, not only hidden here."];
  if (!reason) return <ErrorFocus>{children}</ErrorFocus>;
  return (
    <Card>
      <Banner kind={own ? "warn" : "info"} title={reason[0]}>{reason[1]}</Banner>
      <div className="flex flex-wrap items-center gap-2"><Button asChild variant="outline"><Link to={back.to}>{back.label}</Link></Button></div>
    </Card>
  );
}

/** The wizard top bar: a close link back to where the flow started, and the flow's title. */
export function WizardHead({ title, back }: { title: string; back: string }) {
  return (
    <div className="flex items-center gap-3">
      <Button asChild variant="outline" size="icon-sm"><Link to={back} aria-label="Close" title="Close"><XIcon aria-hidden="true" /></Link></Button>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
    </div>
  );
}
