import { useState } from "react";
import { api } from "#shared";
import { apiRequest, saveFile } from "../api/request.ts";
import { fileStem } from "../components/CapTableDownload.tsx";
import { DataTable, byNumber, byText, type Column } from "../components/DataTable.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { Drawer } from "../components/Dialog.tsx";
import { Badge, ErrorState, Loading } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { usePii } from "../components/Pii.tsx";
import { ACTOR_KIND_LABELS, auditActor, auditChanges, auditDescription } from "../lib/audit.ts";
import { describeError } from "../lib/errors.ts";
import { DASH } from "../lib/format.ts";
import { useCursorPages } from "../lib/useCursorPages.ts";

// Recent Activity: the org's append-only audit log, newest first, 10 rows; search and filters
// (date range, actor, actor type, object type, action); a row opens the field-level diff with the command id. The
// log pages by cursor: the first 200 events load at once and "Load older activity" fetches the next page;
// a failed page can be retried with the same button.

const PAGE_LIMIT = 200;
type ActorType = "person" | "unknown" | "system";

function actorType(event: api.AuditEvent): ActorType {
  if (event.actor.kind === "system" || event.actor.kind === "import") return "system";
  return event.actor.kind === "anonymous" ? "unknown" : "person";
}

export function ActivityPage() {
  const { orgId } = useWorkspace();
  // A new org starts a new log: the pages belong to the component, so it remounts.
  return <ActivityLog key={orgId} />;
}

function ActivityLog() {
  const workspace = useWorkspace();
  const { orgId, format, today, name } = workspace;
  const pii = usePii();
  const log = useCursorPages(
    (cursor, signal) => apiRequest(api.routes.listOrgAudit, { params: { orgId }, query: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }, signal }),
    (event) => String(event.id),
  );
  const [open, setOpen] = useState<api.AuditEvent | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const download = async () => {
    setNotice(null);
    try {
      await saveFile(api.routes.runReport, { params: { orgId, reportKey: "audit-log" }, query: { format: "csv" } }, `${fileStem(name)}_AuditLog_${today}.csv`);
    } catch (cause) {
      setNotice(describeError(cause, { not_found: "This export isn't available." }));
    }
  };

  const actor = (event: api.AuditEvent) => auditActor(event, pii.email);
  const actors = [...new Set(log.items.map(actor))].sort();
  const objectTypes = [...new Set(log.items.map((event) => event.targetType).filter((value): value is string => value !== null))].sort();
  const actions = [...new Set(log.items.map((event) => event.action))].sort();
  const columns: Column<api.AuditEvent>[] = [
    { key: "at", label: "Date & time", minWidth: 150, render: (event) => format.dateTime(event.occurredAt), compare: byNumber((event) => event.occurredAt) },
    {
      key: "description", label: "Description", className: "wrap",
      render: (event) => {
        const changes = auditChanges(event);
        return (
          <>
            <div>
              {auditDescription(event)}
              {event.result !== "success" ? <> <Badge tone={event.result === "denied" ? "amber" : "red"}>{event.result}</Badge></> : null}
            </div>
            {changes.length ? (
              <div className="small muted">
                {changes.slice(0, 3).map((change, index) => <div key={index}>{change.field}: {change.old} → {change.new}</div>)}
                {changes.length > 3 ? <div>+{changes.length - 3} more</div> : null}
              </div>
            ) : null}
          </>
        );
      },
    },
    {
      key: "by", label: "Action by",
      render: (event) => (
        <>
          {actor(event)}
        </>
      ),
      compare: byText(actor),
    },
  ];
  return (
    <Page title="Recent Activity" crumbs={[["Company"], ["Recent Activity"]]}>
      <Card>
        <PageHead title="Recent Activity" sub="Append-only audit log. Click a row for the field-level diff and the command id." />
        {notice ? <p className="err-inline" role="alert">{notice}</p> : null}
        {!log.loaded && log.error !== undefined ? (
          <ErrorState error={log.error} onRetry={log.reload} />
        ) : !log.loaded ? (
          <Loading />
        ) : (
          <>
            <DataTable
              id="audit"
              label="Audit log"
              rows={log.items}
              rowKey={(event) => String(event.id)}
              columns={columns}
              defaultSort={["at", "desc"]}
              search={(event) => `${auditDescription(event)} ${actor(event)} ${event.targetId ?? ""} ${event.action}`}
              searchPlaceholder="Search activity…"
              onRowClick={setOpen}
              rowLabel={(event) => `${auditDescription(event)}, ${format.dateTime(event.occurredAt)}`}
              toolbarExtra={<button type="button" className="btn btn-ghost btn-sm" onClick={() => void download()}><Icon name="download" /> CSV</button>}
              filters={[
                { key: "date", label: "Date range", type: "daterange", test: (event, range) => { const day = format.localDate(event.occurredAt); return (!range.from || day >= range.from) && (!range.to || day <= range.to); } },
                { key: "actor", label: "Actor", options: actors.map((value) => [value, value] as const), test: (event, value) => actor(event) === value },
                { key: "type", label: "Actor type", options: [["person", "Person"], ["unknown", "Unknown"], ["system", "System / import"]], test: (event, value) => actorType(event) === value },
                { key: "object", label: "Object type", options: objectTypes.map((value) => [value, value.replace(/_/g, " ")] as const), test: (event, value) => event.targetType === value },
                { key: "action", label: "Action", options: actions.map((value) => [value, value] as const), test: (event, value) => event.action === value },
              ]}
              empty="No activity yet."
            />
            {log.nextCursor !== null ? (
              <div className="row mt-12">
                <button type="button" className="btn btn-ghost btn-sm" disabled={log.loadingMore} onClick={() => void log.loadMore()}>
                  {log.loadingMore ? "Loading…" : log.moreError !== undefined ? "Try again" : "Load older activity"}
                </button>
                {log.moreError !== undefined ? <span className="err-inline" role="alert">Couldn't load older activity. {describeError(log.moreError)}</span> : null}
              </div>
            ) : null}
          </>
        )}
      </Card>
      {open ? <AuditDrawer event={open} actorLabel={actor(open)} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

function AuditDrawer({ event, actorLabel, onClose }: { event: api.AuditEvent; actorLabel: string; onClose: () => void }) {
  const { format } = useWorkspace();
  const changes = auditChanges(event);
  const detail = (key: string) => (typeof event.details?.[key] === "string" ? String(event.details[key]) : null);
  return (
    <Drawer title="Activity detail" onClose={onClose}>
      <p><b>{auditDescription(event)}</b></p>
      <DescriptionList
        rows={[
          ["When", format.dateTime(event.occurredAt)],
          ["Action by", actorLabel],
          ["Actor type", ACTOR_KIND_LABELS[event.actor.kind]],
          ["Object", event.targetType ? `${event.targetType.replace(/_/g, " ")} ${event.targetId ?? ""}`.trim() : DASH],
          ["Action", <span className="mono">{event.action}</span>],
          ["Result", event.result],
          event.reason ? ["Reason / note", event.reason] : null,
          ["Command id", detail("commandId") ? <span className="mono">{detail("commandId")}</span> : DASH],
          ["Request id", detail("requestId") ? <span className="mono">{detail("requestId")}</span> : DASH],
        ]}
      />
      {changes.length ? (
        <>
          <h4 className="mt-16">Changes</h4>
          <table className="tbl dense" aria-label="Changes">
            <thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
            <tbody>{changes.map((change, index) => <tr key={index}><td>{change.field}</td><td>{change.old}</td><td>{change.new}</td></tr>)}</tbody>
          </table>
        </>
      ) : (
        <p className="muted small">No field-level changes.</p>
      )}
    </Drawer>
  );
}
