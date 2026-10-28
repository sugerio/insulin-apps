import { Link } from "react-router";
import type { api } from "#shared";
import { formatDate } from "../lib/format.ts";
import { securityHref } from "../lib/terms.ts";
import { Badge } from "./Feedback.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";

// Links to stakeholders and securities, with the TERMINATED / TERMINATING badge next to names.

export type HolderStatus = "active" | "terminating" | "terminated";

export interface HolderState {
  status: HolderStatus;
  /** The termination date (scheduled or recorded). */
  date: string | null;
}

export function holderState(stakeholder: Pick<api.Stakeholder, "termination" | "scheduledTermination"> | null | undefined): HolderState {
  if (stakeholder?.scheduledTermination) return { status: "terminating", date: stakeholder.scheduledTermination.terminationDate };
  if (stakeholder?.termination) return { status: "terminated", date: stakeholder.termination.date };
  return { status: "active", date: null };
}

export function TerminationBadge({ state }: { state: HolderState | null | undefined }) {
  if (state?.status === "terminating") return <Badge tone="amber">Terminating {state.date ? formatDate(state.date) : ""}</Badge>;
  if (state?.status === "terminated") return <Badge tone="red">Terminated</Badge>;
  return null;
}

export function HolderLink({ id, name, state }: { id: string; name: string; state?: HolderState | null }) {
  const { href } = useWorkspace();
  return (
    <>
      <Link className="cell-link" to={href(`stakeholders/${id}`)}>{name}</Link>
      {state && state.status !== "active" ? <> <TerminationBadge state={state} /></> : null}
    </>
  );
}

export function SecurityLink({ id, family, displayId }: { id: string; family: api.SecurityFamily; displayId: string }) {
  const { href } = useWorkspace();
  return <Link className="cell-link id" to={href(securityHref({ id, family }))}>{displayId}</Link>;
}
