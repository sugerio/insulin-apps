import { useState } from "react";
import { api } from "#shared";
import { saveFile } from "../api/request.ts";
import { describeError } from "../lib/errors.ts";
import { Modal } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";

// The cap table download dialog: As of and Format, then the server's audited export
// (`GET …/reports/cap-table`), which writes "Cap table downloaded (as of …)" before the first byte. Nothing
// is assembled in the browser, so every export is audited and PII-redacted by the server's rules.

/** "AcmeRobotics": the company part of an export's file name. */
export function fileStem(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "") || "Company";
}

export function CapTableDownloadButton({ asOf }: { asOf?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        <Icon name="download" /> Download
      </button>
      {open ? <CapTableDownloadDialog initialAsOf={asOf} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CapTableDownloadDialog({ initialAsOf, onClose }: { initialAsOf?: string; onClose: () => void }) {
  const { orgId, today, name, canSeePii } = useWorkspace();
  const [asOf, setAsOf] = useState(initialAsOf ?? today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(asOf) && asOf <= today;
  const filename = `${fileStem(name)}_CapTable_${valid ? asOf : today}.xlsx`;
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveFile(
        api.routes.runReport,
        { params: { orgId, reportKey: "cap-table" }, query: { asOf, format: "xlsx", ...(canSeePii ? { includePii: "true" } : {}) } },
        filename,
      );
      onClose();
    } catch (cause) {
      setError(describeError(cause, { not_found: "This export isn't available." }));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Download cap table"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={() => void download()}>
            <Icon name="download" /> {busy ? "Downloading…" : "Download"}
          </button>
        </>
      }
    >
      <div className="form">
        <label>
          As of
          <input type="date" className="inp" value={asOf} max={today} required onChange={(event) => setAsOf(event.target.value)} />
        </label>
        <label>
          Format
          <select className="inp" value="xlsx" onChange={() => undefined}>
            <option value="xlsx">Excel workbook (.xlsx)</option>
          </select>
        </label>
        <p className="small muted">
          Ownership sheet as displayed, one sheet per instrument, and a plan availability summary. File:{" "}
          <span className="mono">{filename}</span>. The download is written to the audit log.
          {canSeePii ? "" : " E-mail columns are blank for your access level."}
        </p>
        {error ? <p className="err-inline" role="alert">{error}</p> : null}
      </div>
    </Modal>
  );
}
