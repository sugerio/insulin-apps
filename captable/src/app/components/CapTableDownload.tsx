import { useId, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { api } from "#shared";
import { saveFile } from "../api/request.ts";
import { describeError } from "../lib/errors.ts";
import { DismissButton, Modal } from "./Dialog.tsx";
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
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <DownloadIcon /> Download
      </Button>
      {open ? <CapTableDownloadDialog initialAsOf={asOf} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CapTableDownloadDialog({ initialAsOf, onClose }: { initialAsOf?: string; onClose: () => void }) {
  const { orgId, today, name, canSeePii } = useWorkspace();
  const [asOf, setAsOf] = useState(initialAsOf ?? today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
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
          <DismissButton onClick={onClose}>Cancel</DismissButton>
          <Button type="button" disabled={!valid || busy} onClick={() => void download()}>
            <DownloadIcon /> {busy ? "Downloading…" : "Download"}
          </Button>
        </>
      }
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-as-of`}>As of</FieldLabel>
          <Input id={`${id}-as-of`} type="date" value={asOf} max={today} required onChange={(event) => setAsOf(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-format`}>Format</FieldLabel>
          <NativeSelect id={`${id}-format`} className="w-full" value="xlsx" onChange={() => undefined}>
            <NativeSelectOption value="xlsx">Excel workbook (.xlsx)</NativeSelectOption>
          </NativeSelect>
          <FieldDescription className="text-xs">
            Ownership sheet as displayed, one sheet per instrument, and a plan availability summary. File:{" "}
            <span className="font-mono">{filename}</span>. The download is written to the audit log.
            {canSeePii ? "" : " E-mail columns are blank for your access level."}
          </FieldDescription>
        </Field>
        {error ? <p className="text-sm font-medium text-destructive" role="alert">{error}</p> : null}
      </FieldGroup>
    </Modal>
  );
}
