import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { useWriteFlow } from "../lib/flow.ts";
import { formatBytes } from "../lib/format.ts";
import { documentKindLabel } from "../lib/labels.ts";
import { FlowProblemBanner } from "./FlowParts.tsx";
import { Icon } from "./Icon.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";

// A document a write needs (a board consent, an executed agreement, a notice of exercise, a 409A report…), or one
// uploaded on its own. Choosing a file sends nothing: the browser reads it and computes its SHA-256
// (WebCrypto), and the upload is reviewed as exactly what will be sent — the name, the type, the size, the checksum,
// the folder and the record it is linked to. "Upload" sends that frozen request with one Idempotency-Key. A lost
// answer keeps the bytes, the headers and the key: "Try again" resends them (the server replays a recorded upload), and
// nothing can close the dialog or leave the page until the outcome is known (lib/unsettled). A header that changes
// after the review (another type, folder or link) drops the review: the upload is reviewed again before it is sent.

export interface UploadedDocument {
  id: string;
  filename: string;
  byteSize: number;
  sha256: string;
}

/** The record an upload is linked to in the same request (the contract's X-Link-Target, X-Link-Id and X-Link-Role). */
export interface UploadLink {
  target: api.LinkTarget;
  role: api.DocumentLinkRole;
  /** What the record is called, for the review ("OPT-1"). */
  label: string;
}

const EXTENSION_TYPES: Record<string, (typeof api.UPLOAD_CONTENT_TYPES)[number]> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  csv: "text/csv",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const ACCEPT = Object.keys(EXTENSION_TYPES).map((extension) => `.${extension}`).join(",");

/** The upload's content type: the browser's, else the extension's; null when the type isn't one the app accepts. */
export function uploadContentType(file: { name: string; type: string }): (typeof api.UPLOAD_CONTENT_TYPES)[number] | null {
  const declared = file.type.split(";")[0]!.trim().toLowerCase();
  if ((api.UPLOAD_CONTENT_TYPES as readonly string[]).includes(declared)) return declared as (typeof api.UPLOAD_CONTENT_TYPES)[number];
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return declared === "" || declared === "application/octet-stream" ? EXTENSION_TYPES[extension] ?? null : null;
}

async function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The largest document the server stores, in words ("10 MiB"), from the contract's limit. */
export const UPLOAD_LIMIT_LABEL = `${Math.floor(api.LIMITS.uploadBytes / (1024 * 1024))} MiB`;

/** A chosen file, read and checksummed in the browser: nothing is sent yet. */
interface Staged {
  filename: string;
  contentType: (typeof api.UPLOAD_CONTENT_TYPES)[number];
  bytes: ArrayBuffer;
  sha256: string;
}

/** Everything an upload sends besides the bytes, frozen at review; the bytes are the ones with this checksum. */
export interface UploadRequest {
  filename: string;
  contentType: string;
  kind: api.DocumentKind;
  sha256: string;
  byteSize: number;
  collectionId: string | null;
  versionOf: string | null;
  link: { type: api.LinkTargetType; id: string; role: api.DocumentLinkRole; label: string } | null;
}

/** The headers of a reviewed upload (`uploadHeadersSchema`): the link's three come together or not at all. */
export function uploadHeaders(request: UploadRequest) {
  return {
    "content-type": request.contentType,
    "x-filename": encodeURIComponent(request.filename),
    "x-document-kind": request.kind,
    "x-content-sha256": request.sha256,
    ...(request.collectionId ? { "x-collection-id": request.collectionId } : {}),
    ...(request.link ? { "x-link-target": request.link.type, "x-link-id": request.link.id, "x-link-role": request.link.role } : {}),
  };
}

interface DocumentUploadProps {
  label: ReactNode;
  kind: api.DocumentKind;
  value: UploadedDocument | null;
  onChange: (document: UploadedDocument | null) => void;
  required?: boolean;
  hint?: ReactNode;
  /** An error the flow or the server placed on this document. */
  error?: string | undefined;
  disabled?: boolean;
  /** The folder the document is filed in (X-Collection-Id). */
  collectionId?: string | null;
  /** Upload a new version of this document instead (`POST …/documents/:id/versions`): the old one stays. */
  versionOf?: string;
  /** Link the stored document to a record in the same request. */
  link?: UploadLink;
  /** The stored document, as the server answered (with its links and visibility). */
  onStored?: (document: api.Document) => void;
  /** Whether a file is chosen but not stored yet (the dialog keeps the headers it reviewed). */
  onStagedChange?: (staged: boolean) => void;
}

export function DocumentUpload({ label, kind, value, onChange, required, hint, error, disabled, collectionId, versionOf, link, onStored, onStagedChange }: DocumentUploadProps) {
  const { orgId } = useWorkspace();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [reading, setReading] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The bytes behind each checksum this component staged: a frozen request is sent with exactly its own bytes.
  const bytesBySha = useRef(new Map<string, ArrayBuffer>());
  const flow = useWriteFlow<UploadRequest, null, UploadRequest, api.Document>({
    request: () => {
      if (!staged) throw new Error("Choose a file first.");
      return {
        filename: staged.filename,
        contentType: staged.contentType,
        kind,
        sha256: staged.sha256,
        byteSize: staged.bytes.byteLength,
        collectionId: collectionId ?? null,
        versionOf: versionOf ?? null,
        link: link ? { type: link.target.type, id: link.target.id, role: link.role, label: link.label } : null,
      };
    },
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => {
      const bytes = bytesBySha.current.get(body.sha256);
      if (!bytes) throw new Error("The reviewed file is no longer in the browser: choose it again.");
      const headers = uploadHeaders(body);
      return body.versionOf
        ? apiRequest(api.routes.uploadDocumentVersion, { params: { orgId, id: body.versionOf }, body: bytes, headers, idempotencyKey: key })
        : apiRequest(api.routes.uploadDocument, { params: { orgId }, body: bytes, headers, idempotencyKey: key });
    },
    // After a lost answer: a stored document with this checksum and name, among the newest of its record or type, may be
    // this one (a retry with the same key then replays it); none means nothing was stored.
    reconcile: async ({ request }) => {
      const query = request.link
        ? { targetType: request.link.type, targetId: request.link.id, limit: 50 }
        : { kind: request.kind, limit: 50, ...(request.collectionId ? { collectionId: request.collectionId } : {}) };
      const page = await apiRequest(api.routes.listDocuments, { params: { orgId }, query });
      return page.items.some((document) => document.sha256 === request.sha256 && document.filename === request.filename) ? "unknown" : "not_recorded";
    },
    onCommitted: (document) => {
      setStaged(null);
      onChange({ id: document.id, filename: document.filename, byteSize: document.byteSize, sha256: document.sha256 });
      onStored?.(document);
    },
  });

  // A staged file is reviewed once it has rendered (the request is built from it), never in the event that staged it.
  const [reviewFor, setReviewFor] = useState<string | null>(null);
  useEffect(() => {
    if (reviewFor === null) return;
    setReviewFor(null);
    void flow.review();
  }, [reviewFor, flow]);
  useEffect(() => {
    onStagedChange?.(staged !== null);
  }, [staged, onStagedChange]);

  const choose = async (file: File) => {
    setRefusal(null);
    const contentType = uploadContentType(file);
    if (!contentType) {
      setRefusal(`${file.name}: use a PDF, DOCX, XLSX, CSV, TXT, PNG or JPG file.`);
      return;
    }
    if (file.size > api.LIMITS.uploadBytes) {
      setRefusal(`${file.name} is larger than ${UPLOAD_LIMIT_LABEL}.`);
      return;
    }
    setReading(true);
    try {
      const bytes = await readBytes(file);
      const sha256 = await sha256Hex(bytes);
      bytesBySha.current.set(sha256, bytes);
      setStaged({ filename: file.name, contentType, bytes, sha256 });
      setReviewFor(sha256);
    } catch {
      setRefusal(`${file.name}: the file couldn't be read. Choose it again.`);
    } finally {
      setReading(false);
      if (input.current) input.current.value = "";
    }
  };
  const discard = () => {
    flow.edit();
    flow.clearProblem();
    setStaged(null);
  };

  const reviewed = flow.request;
  const unsettled = flow.unsettled;
  const errorText = refusal ?? error;
  return (
    <div className="fld">
      <label htmlFor={id}>
        {label}
        {required ? <span className="req" aria-hidden="true">*</span> : null}
      </label>
      <div className="upload">
        {value && !staged ? (
          <div className="files">
            <span className="file-pill">
              <Icon name="file" /> {value.filename} <span className="faint">{formatBytes(value.byteSize)} · SHA-256 {value.sha256.slice(0, 10)}…</span>
              {disabled ? null : (
                <button type="button" className="pill-x" aria-label={`Remove ${value.filename}`} onClick={() => onChange(null)}>
                  <Icon name="x" />
                </button>
              )}
            </span>
          </div>
        ) : null}
        {staged ? (
          <div className="upload-review" aria-label={`Upload of ${staged.filename}`}>
            <FlowProblemBanner problem={flow.problem} onRetry={flow.phase === "edit" ? () => void flow.review() : () => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
            <p className="small" style={{ margin: "4px 0" }}>
              <Icon name="file" /> Upload <b>{staged.filename}</b> ({formatBytes(staged.bytes.byteLength)}, SHA-256 <span className="mono">{staged.sha256.slice(0, 10)}…</span>)
              {reviewed ? <> as <b>{documentKindLabel(reviewed.kind)}</b>{reviewed.collectionId ? " into the chosen folder" : ""}{reviewed.versionOf ? ", as a new version" : ""}{reviewed.link ? <>, linked to <b>{reviewed.link.label}</b></> : null}</> : null}.
              {value ? <> It replaces {value.filename} here.</> : null}
            </p>
            <div className="row">
              {/* The field's label names its current action, so errors placed on the field still reach it. */}
              {flow.phase === "edit" ? (
                <button type="button" id={id} className="btn btn-ghost btn-sm" aria-label="Review the upload" onClick={() => void flow.review()} disabled={disabled}
                  aria-invalid={errorText ? true : undefined} aria-describedby={errorText ? `${id}-err` : undefined}>Review the upload</button>
              ) : flow.phase === "review" ? (
                <button type="button" id={id} className="btn btn-primary btn-sm" aria-label={`Upload ${staged.filename}`} onClick={() => void flow.commit()} disabled={disabled}
                  aria-invalid={errorText ? true : undefined} aria-describedby={errorText ? `${id}-err` : undefined}>Upload</button>
              ) : flow.phase === "committing" ? (
                <span className="small muted" role="status">Uploading…</span>
              ) : null}
              {!unsettled ? <button type="button" className="btn btn-ghost btn-sm" aria-label={`Don't upload ${staged.filename}`} onClick={discard} disabled={disabled && flow.phase !== "edit"}>Choose another file</button> : null}
            </div>
          </div>
        ) : (
          <label className="btn btn-ghost btn-sm" aria-disabled={disabled || reading || undefined}>
            <Icon name="upload" /> {value ? "Replace file" : "Choose file"}
            <input
              ref={input}
              id={id}
              type="file"
              className="sr-only"
              accept={ACCEPT}
              disabled={disabled || reading}
              aria-required={required || undefined}
              aria-invalid={errorText ? true : undefined}
              aria-describedby={errorText ? `${id}-err` : undefined}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void choose(file);
              }}
            />
          </label>
        )}
        {reading ? <span className="small muted" role="status">Reading the file…</span> : null}
        <div className="hint">{hint ?? `PDF, DOCX, XLSX, CSV, TXT, PNG or JPG · max ${UPLOAD_LIMIT_LABEL} · stored with a SHA-256 checksum`}</div>
      </div>
      {errorText ? <div className="err" id={`${id}-err`} role="alert">{errorText}</div> : null}
    </div>
  );
}
