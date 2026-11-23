import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { FileUp, FolderUp } from "lucide-react";
import { MAX_DOCUMENT_BYTES, canPrepare, routes, type DocumentList, type DocumentRecord, type ReadResult } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";
import { apiRequest, describeError, saveFile } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, useReturn, useYear } from "../components/YearFrame.tsx";
import { uploadFile, uploadType } from "../lib/upload.ts";
import { useResource } from "../lib/useResource.ts";
import { documentName } from "../shared/engine/rules.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 2, `/returns/:year/:personId/upload`: pick a folder (or files, or drop them), and each PDF, PNG or JPEG is sent
// on its own, three at a time, into the open return for AI to read into slips. A file being read, one that wasn't saved
// (skipped, already here, an error) and one that replaced an earlier version of the same name show in the list of this
// upload; a saved file is under "Uploaded files", where it can be read again (when reading it failed) or deleted with
// the slips read from it.

const PARALLEL = 3;

type Row = { key: string; name: string } & (
  | { state: "waiting" }
  | { state: "reading" }
  | { state: "skipped"; message: string }
  | { state: "error"; message: string }
  | { state: "note"; badge: string; message: string }
);

/** What to keep in this upload's list for a file read: nothing for a file saved as is (it is under "Uploaded files"). */
function noteOf(result: ReadResult): { badge: string; message: string } | null {
  if (result.replaced.length > 0) return { badge: "Replaced", message: result.message };
  if (result.document) return null;
  return { badge: result.status === "duplicate" ? "Already here" : "Not saved", message: result.message };
}

export function UploadStep() {
  const { year } = useYear();
  const documents = useResource(`documents-${year.year}-${year.revision}`, (signal) => apiRequest(routes.listDocuments, { params: { year: year.year }, signal }));
  // Uploads bump the year's revision, so the files list waits for them before deleting or reading again.
  const [uploading, setUploading] = useState(false);
  // Kept here: the files list reloads (and remounts) whenever the year changes.
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <StepLayout step="upload" title="Upload documents">
      <Uploader onUploading={setUploading} />
      {notice ? (
        <Banner kind="info" action={<Button variant="outline" size="sm" onClick={() => setNotice(null)}>Dismiss</Button>}>
          {notice}
        </Banner>
      ) : null}
      <ResourceView resource={documents}>{(data) => <Uploaded data={data} uploading={uploading} onNotice={setNotice} />}</ResourceView>
    </StepLayout>
  );
}

function Uploader({ onUploading }: { onUploading: (uploading: boolean) => void }) {
  const me = useMe();
  const { year, replace } = useYear();
  const { person } = useReturn();
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const editable = canPrepare(me);

  function update(key: string, row: Row | null) {
    setRows((current) => (row ? current.map((each) => (each.key === key ? row : each)) : current.filter((each) => each.key !== key)));
  }

  async function send(files: File[]) {
    const batch = files.map((file, index) => ({ file, key: `${Date.now()}-${index}-${file.name}` }));
    const queued: { file: File; key: string; type: string }[] = [];
    const initial: Row[] = batch.map(({ file, key }) => {
      const type = uploadType(file);
      if (!type) return { key, name: file.name, state: "skipped", message: "Not a PDF, PNG or JPEG." };
      if (file.size > MAX_DOCUMENT_BYTES) return { key, name: file.name, state: "skipped", message: "Larger than 10 MiB." };
      if (file.size === 0) return { key, name: file.name, state: "skipped", message: "Empty file." };
      queued.push({ file, key, type });
      return { key, name: file.name, state: "waiting" };
    });
    setRows((current) => [...initial, ...current]);
    if (queued.length === 0) return;

    const next = async (): Promise<void> => {
      const item = queued.shift();
      if (!item) return;
      update(item.key, { key: item.key, name: item.file.name, state: "reading" });
      try {
        const result: ReadResult = await uploadFile(year.year, person.id, item.file, item.type);
        // A saved file is listed under "Uploaded files"; one that wasn't, or that replaced another, stays here with why.
        const note = noteOf(result);
        update(item.key, note ? { key: item.key, name: item.file.name, state: "note", ...note } : null);
        // Uploads finish in any order: the year keeps the newest of their answers.
        replace(result.year);
      } catch (error) {
        update(item.key, { key: item.key, name: item.file.name, state: "error", message: describeError(error) });
      }
      return next();
    };
    onUploading(true);
    try {
      await Promise.all(Array.from({ length: PARALLEL }, next));
    } finally {
      onUploading(false);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (editable) void send([...event.dataTransfer.files]);
  }

  const reading = rows.some((row) => row.state === "waiting" || row.state === "reading");
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {editable ? (
          <div
            className={cn("flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-8 text-center", dragging && "border-primary bg-primary/5")}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <p className="text-sm font-medium wrap-anywhere">
              {year.country === "us"
                ? `${person.name}'s Forms W-2 and 1099-INT for ${year.year}`
                : `${person.name}'s slips and receipts for ${year.year}, and last year's notice of assessment`}
            </p>
            <p className="text-xs text-muted-foreground">
              {year.country === "us" ? "They are kept with the return but can't be read yet: enter each one on Income. " : ""}PDF, PNG or JPEG, up to
              10 MiB each. Drop them here, or choose:
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => folderInput.current?.click()} disabled={reading}>
                <FolderUp aria-hidden="true" />
                Choose a folder
              </Button>
              <Button variant="outline" onClick={() => filesInput.current?.click()} disabled={reading}>
                <FileUp aria-hidden="true" />
                Choose files
              </Button>
            </div>
            <input
              ref={folderInput}
              type="file"
              className="hidden"
              aria-label="Choose a folder"
              {...({ webkitdirectory: "" } as Record<string, string>)}
              onChange={(event) => {
                void send([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <input
              ref={filesInput}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              className="hidden"
              aria-label="Choose files"
              onChange={(event) => {
                void send([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
          </div>
        ) : null}
        {rows.length > 0 ? (
          <ul className="flex flex-col divide-y" aria-label="This upload">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                <RowStatus row={row} />
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex justify-end">
          <Button asChild variant={rows.length > 0 && !reading ? "default" : "outline"}>
            <Link to={stepPath(year.year, person.id, "income")}>Next: income</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RowStatus({ row }: { row: Row }) {
  if (row.state === "waiting") return <span className="text-muted-foreground">Waiting</span>;
  if (row.state === "reading") return <span className="text-muted-foreground">Reading…</span>;
  if (row.state === "skipped") return <span className="text-muted-foreground">Skipped: {row.message}</span>;
  if (row.state === "error") return <span className="text-destructive">{row.message}</span>;
  return (
    <span className="flex min-w-0 basis-full flex-wrap items-baseline gap-2 sm:basis-auto">
      <Badge variant={row.badge === "Not saved" ? "destructive" : "outline"}>{row.badge}</Badge>
      <span className="min-w-0 text-muted-foreground wrap-anywhere">{row.message}</span>
    </span>
  );
}

const STATUS_LABELS: Record<DocumentRecord["status"], string> = {
  read: "Read",
  not_a_slip: "No slip found",
  failed: "Couldn't read",
  not_available: "Reading not set up",
};

/** Files that weren't read: they have no slips, and can be read again. */
const UNREAD: readonly DocumentRecord["status"][] = ["failed", "not_available"];

export function DocumentStatus({ document }: { document: DocumentRecord }) {
  return (
    <span className="flex min-w-0 basis-full flex-wrap items-baseline gap-2 sm:basis-auto">
      <Badge variant={document.status === "read" ? "secondary" : UNREAD.includes(document.status) ? "destructive" : "outline"}>{STATUS_LABELS[document.status]}</Badge>
      <span className="min-w-0 text-muted-foreground wrap-anywhere">{document.message}</span>
    </span>
  );
}

/**
 * The files of the open return: uploaded in it, or holding a slip of its adult. A file uploaded before returns were per
 * person, with no slip, is the person preparing's.
 */
function Uploaded({ data, uploading, onNotice }: { data: DocumentList; uploading: boolean; onNotice: (notice: string | null) => void }) {
  const { year } = useYear();
  const { person, members } = useReturn();
  const preparing = year.returns[0]?.personId;
  const onReturn = (personId: string | null) => members.some((member) => member.id === personId);
  const documents = data.documents.filter(
    (document) =>
      onReturn(document.personId) || document.slips.some((slip) => onReturn(slip.personId)) || (document.personId === null && document.slips.length === 0 && person.id === preparing),
  );
  if (documents.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Uploaded files</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {documents.map((document) => (
            <UploadedFile key={document.id} document={document} uploading={uploading} onNotice={onNotice} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type FileState = { status: "idle" } | { status: "confirming" } | { status: "working"; action: "delete" | "read" | "download" } | { status: "error"; error: unknown };

/** One uploaded file: download it, read it again when reading failed, or delete it (after saying which slips go with it). */
function UploadedFile({ document, uploading, onNotice }: { document: DocumentRecord; uploading: boolean; onNotice: (notice: string | null) => void }) {
  const me = useMe();
  const { year, replace } = useYear();
  const [state, setState] = useState<FileState>({ status: "idle" });
  const editable = canPrepare(me);
  const working = state.status === "working";
  const nameOf = (personId: string) => year.people.find((each) => each.id === personId)?.name ?? "someone";

  async function remove() {
    setState({ status: "working", action: "delete" });
    try {
      const updated = await apiRequest(routes.deleteDocument, { params: { year: year.year, id: document.id }, body: { revision: year.revision } });
      onNotice(null);
      replace(updated);
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  async function download() {
    setState({ status: "working", action: "download" });
    try {
      await saveFile(`/api/years/${year.year}/documents/${document.id}/file`, document.name);
      setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  async function readAgain() {
    setState({ status: "working", action: "read" });
    try {
      const result = await apiRequest(routes.readDocumentAgain, { params: { year: year.year, id: document.id } });
      onNotice(result.document ? null : `${document.name}: ${result.message} The file was removed.`);
      replace(result.year);
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium underline-offset-2 hover:underline disabled:opacity-50"
          disabled={working}
          aria-label={`Download ${document.name}`}
          onClick={() => void download()}
        >
          {working && state.action === "download" ? `Downloading ${document.name}…` : document.name}
        </button>
        {editable && state.status !== "confirming" ? (
          <span className="flex shrink-0 gap-1">
            {UNREAD.includes(document.status) ? (
              <Button variant="ghost" size="sm" disabled={working || uploading} onClick={() => void readAgain()} aria-label={`Read ${document.name} again`}>
                {working && state.action === "read" ? "Reading…" : "Read again"}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" className="text-destructive" disabled={working || uploading} onClick={() => setState({ status: "confirming" })} aria-label={`Delete ${document.name}`}>
              {working && state.action === "delete" ? "Deleting…" : "Delete"}
            </Button>
          </span>
        ) : null}
      </div>
      <DocumentStatus document={document} />
      {state.status === "confirming" ? (
        <Banner
          kind="warning"
          title={`Delete ${document.name}?`}
          action={
            <span className="flex gap-2">
              <Button variant="destructive" size="sm" disabled={uploading} onClick={() => void remove()}>
                Delete file
              </Button>
              <Button variant="outline" size="sm" onClick={() => setState({ status: "idle" })}>
                Cancel
              </Button>
            </span>
          }
        >
          {document.slips.length === 0 ? (
            "No slips were read from it."
          ) : (
            <>
              The slips read from it are deleted too:
              <ul className="mt-1 list-disc pl-5 wrap-anywhere">
                {document.slips.map((slip) => (
                  <li key={slip.id}>
                    {documentName(rulesFor(year.country, year.year)!.slips.get(slip.type), slip.type)} from {slip.issuer}, on {nameOf(slip.personId)}'s return{slip.status === "confirmed" ? " (confirmed)" : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Banner>
      ) : null}
      {state.status === "error" ? <span className="text-xs text-destructive">{describeError(state.error)}</span> : null}
    </li>
  );
}
