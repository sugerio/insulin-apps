import { useState } from "react";
import { api } from "#shared";
import { saveFile } from "../api/request.ts";
import { fileStem } from "../components/CapTableDownload.tsx";
import { Icon } from "../components/Icon.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { describeError } from "../lib/errors.ts";

// Company › Reports: every export the server produces, in each format it offers. Each run is the server's
// audited export (`GET …/reports/:reportKey`), redacted by its rules for whoever may not see personal data; nothing is
// assembled in the browser.

interface ReportSpec {
  key: api.ReportKey;
  title: string;
  description: string;
  /** Holdings reports are computed as of a date; the activity and exercise logs are whole. */
  asOf: boolean;
  /** The file name's middle part: "AcmeRobotics_CapTable_2026-10-21.xlsx". */
  stem: string;
}

const REPORTS: readonly ReportSpec[] = [
  { key: "cap-table", title: "Cap table", description: "Ownership by stakeholder and class, one sheet per instrument, and plan availability.", asOf: true, stem: "CapTable" },
  { key: "raw-cap-table", title: "Raw cap table", description: "Every security with its holder, class, plan and numbers, one row each.", asOf: true, stem: "RawCapTable" },
  { key: "stakeholders", title: "Stakeholders", description: "Everyone on the cap table with their details and holdings.", asOf: true, stem: "Stakeholders" },
  { key: "vesting-details", title: "Vesting details", description: "Each grant's vesting schedule, vested and unvested quantities.", asOf: true, stem: "VestingDetails" },
  { key: "exercise-history", title: "Exercise history", description: "Every recorded exercise with its payment and resulting shares.", asOf: false, stem: "ExerciseHistory" },
  { key: "audit-log", title: "Audit log", description: "The company's activity log: who did what, and when.", asOf: false, stem: "AuditLog" },
];

const FORMAT_LABELS: Record<api.ReportFormat, string> = { xlsx: "Excel", csv: "CSV", json: "JSON" };

export function ReportsPage() {
  const { orgId, today, name, canSeePii } = useWorkspace();
  const [asOf, setAsOf] = useState(today);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(asOf) && asOf <= today;
  const download = async (report: ReportSpec, format: api.ReportFormat) => {
    const id = `${report.key}.${format}`;
    setBusy(id);
    setError(null);
    try {
      await saveFile(
        api.routes.runReport,
        {
          params: { orgId, reportKey: report.key },
          query: { format, ...(report.asOf ? { asOf } : {}), ...(canSeePii ? { includePii: "true" } : {}) },
        },
        `${fileStem(name)}_${report.stem}_${report.asOf ? asOf : today}.${format}`,
      );
    } catch (cause) {
      setError(`${report.title}: ${describeError(cause, { not_found: "This export isn't available." })}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Page title="Reports" crumbs={[["Company"], ["Reports"]]}>
      <Card>
        <PageHead title="Reports" sub="Exports of the cap table and its records. Each download is written to the audit log." />
        <div className="form" style={{ maxWidth: 260 }}>
          <label>
            As of
            <input type="date" className="inp" value={asOf} max={today} required onChange={(event) => setAsOf(event.target.value)} />
          </label>
        </div>
        {!validDate ? <p className="err-inline" role="alert">Choose a date up to today.</p> : null}
        {error ? <p className="err-inline" role="alert">{error}</p> : null}
        <div className="tbl-scroll mt-12">
          <table className="tbl" aria-label="Reports">
            <thead><tr><th scope="col">Report</th><th scope="col">What it holds</th><th scope="col"><span className="sr-only">Download</span></th></tr></thead>
            <tbody>
              {REPORTS.map((report) => (
                <tr key={report.key}>
                  <td><b>{report.title}</b>{report.asOf ? <div className="small muted">As of the date above</div> : null}</td>
                  <td className="small">{report.description}</td>
                  <td className="right nowrap">
                    <span className="row">
                      {api.reportFormats(report.key).map((format) => (
                        <button key={format} type="button" className="btn btn-ghost btn-sm" disabled={busy !== null || (report.asOf && !validDate)}
                          aria-label={`Download the ${report.title.toLowerCase()} as ${FORMAT_LABELS[format]}`} onClick={() => void download(report, format)}>
                          <Icon name="download" /> {busy === `${report.key}.${format}` ? "Downloading…" : FORMAT_LABELS[format]}
                        </button>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canSeePii ? null : <p className="small muted mt-8">Personal data (e-mails, addresses, phone numbers) is left out for your access level.</p>}
      </Card>
    </Page>
  );
}
