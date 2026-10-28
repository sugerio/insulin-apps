import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { auditActor, auditDescription } from "../lib/audit.ts";
import { useResource } from "../lib/useResource.ts";
import { Badge, InlineError } from "./Feedback.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";
import { usePii } from "./Pii.tsx";
import { Timeline } from "./Timeline.tsx";

/** A record's Activity section: its audit events, newest first (`GET …/audit?targetId=`). */
export function RecordActivity({ targetId, limit = 12 }: { targetId: string; limit?: number }) {
  const { orgId, format } = useWorkspace();
  const pii = usePii();
  const resource = useResource(
    (signal) => apiRequest(api.routes.listOrgAudit, { params: { orgId }, query: { targetId, limit }, signal }),
    [orgId, targetId, limit],
  );
  if (!resource.data && resource.error !== undefined) return <InlineError what="the activity" error={resource.error} onRetry={resource.reload} />;
  if (!resource.data) return <p className="muted small" role="status">Loading activity…</p>;
  return (
    <Timeline
      label="Activity"
      items={resource.data.items.map((event) => ({
        key: String(event.id),
        title: (
          <>
            {auditDescription(event)}
            {event.result !== "success" ? <> <Badge tone={event.result === "denied" ? "amber" : "red"}>{event.result}</Badge></> : null}
          </>
        ),
        meta: `${format.dateTime(event.occurredAt)} · ${auditActor(event, pii.email)}`,
      }))}
    />
  );
}
