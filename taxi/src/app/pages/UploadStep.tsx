import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { FileUp, FolderUp } from "lucide-react";
import { MAX_DOCUMENT_BYTES, canPrepare, routes, type DocumentList, type DocumentRecord } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";
import { apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { ResourceView } from "../components/Feedback.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, useYear } from "../components/YearFrame.tsx";
import { uploadFile, uploadType } from "../lib/upload.ts";
import { useResource } from "../lib/useResource.ts";

// Step 2, `/returns/:year/upload`: pick a folder (or files, or drop them), and each PDF, PNG or JPEG is sent on its own,
// three at a time, for AI to read into slips. Each file's row shows what was found as its answer arrives. The slips
// land unconfirmed in step 4.

const PARALLEL = 3;

type Row =
  | { key: string; name: string; state: "waiting" | "reading" }
  | { key: string; name: string; state: "skipped"; message: string }
  | { key: string; name: string; state: "done"; document: DocumentRecord }
  | { key: string; name: string; state: "error"; message: string };

export function UploadStep() {
  const { year } = useYear();
  const documents = useResource(`documents-${year.year}-${year.revision}`, (signal) => apiRequest(routes.listDocuments, { params: { year: year.year }, signal }));
  return (
    <StepLayout step="upload" title="Upload documents">
      <Uploader />
      <ResourceView resource={documents}>{(data) => <Uploaded data={data} />}</ResourceView>
    </StepLayout>
  );
}

function Uploader() {
  const me = useMe();
  const { year, replace } = useYear();
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const latest = useRef(year.revision);
  const editable = canPrepare(me);

  function update(key: string, row: Row) {
    setRows((current) => current.map((each) => (each.key === key ? row : each)));
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

    const next = async (): Promise<void> => {
      const item = queued.shift();
      if (!item) return;
      update(item.key, { key: item.key, name: item.file.name, state: "reading" });
      try {
        const result = await uploadFile(year.year, item.file, item.type);
        update(item.key, { key: item.key, name: item.file.name, state: "done", document: result.document });
        // Uploads finish in any order: keep the newest year.
        if (result.year.revision > latest.current) {
          latest.current = result.year.revision;
          replace(result.year);
        }
      } catch (error) {
        update(item.key, { key: item.key, name: item.file.name, state: "error", message: describeError(error) });
      }
      return next();
    };
    await Promise.all(Array.from({ length: PARALLEL }, next));
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
            <p className="text-sm font-medium">This year's slips and receipts, and last year's notices of assessment</p>
            <p className="text-xs text-muted-foreground">PDF, PNG or JPEG, up to 10 MiB each. Drop them here, or choose:</p>
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
          <ul className="flex flex-col divide-y" aria-label="Files being read">
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
            <Link to={stepPath(year.year, "applies")}>Next: what applies</Link>
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
  if (row.state === "done") return <DocumentStatus document={row.document} />;
  return null;
}

const STATUS_LABELS: Record<DocumentRecord["status"], string> = {
  read: "Read",
  duplicate: "Already here",
  not_a_slip: "No slip found",
  failed: "Couldn't read",
  not_available: "AI reading not set up",
};

export function DocumentStatus({ document }: { document: DocumentRecord }) {
  return (
    <span className="flex min-w-0 basis-full flex-wrap items-baseline gap-2 sm:basis-auto">
      <Badge variant={document.status === "read" ? "secondary" : document.status === "failed" || document.status === "not_available" ? "destructive" : "outline"}>
        {STATUS_LABELS[document.status]}
      </Badge>
      <span className="text-muted-foreground">{document.message}</span>
    </span>
  );
}

function Uploaded({ data }: { data: DocumentList }) {
  const { year } = useYear();
  if (data.documents.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Uploaded files</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {data.documents.map((document) => (
            <li key={document.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm">
              {document.status === "duplicate" ? (
                <span className="min-w-0 flex-1 truncate font-medium">{document.name}</span>
              ) : (
                <a className="min-w-0 flex-1 truncate font-medium underline-offset-2 hover:underline" href={`/api/years/${year.year}/documents/${document.id}/file`} target="_blank" rel="noreferrer">
                  {document.name}
                </a>
              )}
              <DocumentStatus document={document} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
