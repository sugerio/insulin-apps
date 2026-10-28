import "./import.css";
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link, useBlocker } from "react-router";
import { api } from "#shared";
import { ApiRequestError, apiRequest, isAbortError, newIdempotencyKey, saveFile } from "../api/request.ts";
import { useAuth } from "../auth/AuthProvider.tsx";
import { describeError, isApiError } from "../lib/errors.ts";
import { isAmbiguous } from "../lib/flow.ts";
import { formatBytes, formatDate, plural } from "../lib/format.ts";
import {
  FILES_TOTAL_LABEL, FILE_LIMIT_LABEL, PULLEY_REPORTS, acceptedExtensions, fileKindLabel, fileWarnings, filesProblem, splitProblems,
  type ImportSource,
} from "../lib/imports.ts";
import { useImportFiles } from "../lib/useImportFiles.ts";
import { ErrorFocus } from "./ErrorFocus.tsx";
import { Banner } from "./Feedback.tsx";
import { BlockList, DateField, TextField } from "./Form.tsx";
import { Icon } from "./Icon.tsx";
import { Assumptions, DetectedFiles, ImportCounts, ImportTotals, OpeningBalances, ProblemSections } from "./ImportPreview.tsx";
import { Card } from "./Page.tsx";

// The import wizard: choose the source (Pulley's exports or the Cap Table spreadsheet) → upload → review the server's
// preview → import → done. It sets up an empty company in one step, at first-run setup or later from Import.
// - The files live in the page's memory only (lib/useImportFiles), from the moment they are chosen until the import is
//   done, when they are let go: the commit sends the very files the preview was made from, and nothing goes to browser
//   storage.
// - The preview is the server's: the browser never parses a workbook. Import stays off while it reports any blocking
//   problem, and "Upload corrected files" goes back to the files for a fresh preview.
// - One Idempotency-Key per reviewed preview: a retry after a lost answer resends the same files and key, and the server
//   answers with the finished import instead of running it twice. While the outcome is unknown the wizard holds in-app
//   navigation (there is no browser "leave this page?" prompt: the app runs in the console's frame).
// - An import creates a new company, so afterwards the app reads /api/me again and opens that company.

type Step = "source" | "upload" | "preview" | "importing" | "done";

const STEPS: readonly (readonly [Step, string])[] = [
  ["source", "Choose the source"],
  ["upload", "Upload the files"],
  ["preview", "Review the preview"],
  ["importing", "Import"],
  ["done", "Done"],
];

/** A preview the server made, with exactly what it was made from: the commit sends the same files and date again. */
interface Checked {
  runId: string;
  preview: api.ImportPreview;
  source: ImportSource;
  files: File[];
  /** The as-of date sent with the preview; null when the files' own date applied. */
  sentDate: string | null;
  /** The date the preview used: the one sent, or the one the run stored from the files (null: none; undefined: not read). */
  date: string | null | undefined;
  profile: { timezone: string; jurisdiction: string; fiscalYearEnd: string };
  /** One key for importing this preview, however often it is retried. */
  key: string;
}

type Sending = { kind: "sending" } | { kind: "checking" } | { kind: "unresolved"; message: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GONE = "This preview is no longer on the server. Check the files again, then import.";

/** A refused call in words, with the issues or violations the server (or the client's own contract check) listed. */
function refusal(error: unknown, messages: Parameters<typeof describeError>[1] = {}): string {
  const body = error instanceof ApiRequestError ? error.body?.error : undefined;
  const issues = [...(body?.issues ?? []), ...(body?.violations ?? [])].map((item) => item.message);
  const text = describeError(error, {
    payload_too_large: `The files are too large. Each file can be up to ${FILE_LIMIT_LABEL}, and all of them together up to ${FILES_TOTAL_LABEL}.`,
    ...messages,
  });
  return [text, ...issues.filter((issue) => issue !== text)].join(" ");
}

/**
 * Why the outcome of an import is unknown. Not the generic sentence for a 503 ("Nothing was changed"): an import that
 * stopped half-way leaves nothing visible, but one whose answer was lost may well have finished.
 */
function lostAnswer(error: unknown): string {
  return isApiError(error, "network_error") ? "The connection dropped before the server answered." : "The server didn't confirm the import.";
}

/**
 * The as-of date the server stored with a run: the date it took from the files when none was entered (the preview's
 * `suggestedAsOfDate` is only a suggestion). Null when the run has none; undefined when it can't be read just now.
 */
async function storedDate(runId: string, signal?: AbortSignal): Promise<string | null | undefined> {
  try {
    const date: string | null = (await apiRequest(api.routes.getImportRun, { params: { runId }, signal })).asOfDate;
    return date;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

/** "Download the template": the blank Cap Table spreadsheet, saved through a blob URL and `<a download>` (frame-safe). */
export function TemplateDownloadButton() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await saveFile(api.routes.downloadImportTemplate, {}, "cap-table-template.xlsx");
    } catch (error) {
      setProblem(`Couldn't download the template. ${describeError(error, { not_found: "The template isn't available." })}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="template-download">
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void download()}>
        <Icon name="download" /> {busy ? "Downloading…" : "Download the template"}
      </button>
      {problem ? <span className="err-inline" role="alert">{problem}</span> : null}
    </span>
  );
}

/** One way to start, as a card with its actions: the setup page's three and the wizard's two sources. */
export function ChoiceCard({ title, level = 3, children, actions }: { title: string; level?: 2 | 3; children: ReactNode; actions: ReactNode }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <li className="choice">
      <div className="choice-text">
        <Heading className="choice-t">{title}</Heading>
        <p className="choice-s">{children}</p>
      </div>
      <div className="choice-a">{actions}</div>
    </li>
  );
}

function DropZone({ source, disabled, onFiles }: { source: ImportSource; disabled: boolean; onFiles: (files: File[]) => void }) {
  // Entering a child element fires dragleave on the parent: count the enters so the highlight doesn't flicker.
  const [depth, setDepth] = useState(0);
  const multiple = source === "pulley";
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDepth(0);
    if (!disabled) onFiles(Array.from(event.dataTransfer?.files ?? []));
  };
  return (
    <div
      className={depth > 0 && !disabled ? "dropzone over" : "dropzone"}
      role="group"
      aria-label="Upload area"
      onDragEnter={(event) => {
        event.preventDefault();
        setDepth((count) => count + 1);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDepth((count) => Math.max(0, count - 1))}
      onDrop={drop}
    >
      <Icon name="upload" />
      <span>{multiple ? "Drag and drop the exported files here, or" : "Drag and drop the spreadsheet here, or"}</span>
      <label className="btn btn-ghost btn-sm" aria-disabled={disabled || undefined}>
        {multiple ? "Choose files" : "Choose a file"}
        <input
          type="file"
          className="sr-only"
          multiple={multiple}
          accept={acceptedExtensions(source).join(",")}
          disabled={disabled}
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (chosen.length) onFiles(chosen);
          }}
        />
      </label>
      <span className="small muted">{multiple ? `Excel or CSV, up to ${FILE_LIMIT_LABEL} each and ${FILES_TOTAL_LABEL} together` : `An Excel workbook (.xlsx), up to ${FILE_LIMIT_LABEL}`}</span>
    </div>
  );
}

function FileList({ files, detected, disabled, onRemove }: { files: readonly File[]; detected: ReadonlyMap<File, api.ImportDetectedFile["kind"]>; disabled: boolean; onRemove: (file: File) => void }) {
  return (
    <ul className="file-list" aria-label="Chosen files">
      {files.map((file) => {
        // What the last preview recognized this very file as (a replaced file has no label until it is checked).
        const kind = detected.get(file);
        return (
          <li key={file.name}>
            <Icon name="file" />
            <span className="fl-name">{file.name}</span>
            <span className="small muted">{formatBytes(file.size)}</span>
            {kind !== undefined ? <span className={kind === null ? "small fl-bad" : "small muted"}>{fileKindLabel(kind)}</span> : null}
            <button type="button" className="pill-x" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => onRemove(file)}>
              <Icon name="x" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Whole seconds since `running` last became true. */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return seconds;
}

export interface ImportWizardProps {
  /** The source chosen before the wizard opened (the setup page asks first); without one the wizard asks. */
  initialSource?: ImportSource;
  /** Leaves the wizard from its first step (back to the setup choices). */
  onExit?: () => void;
  exitLabel?: string;
  /** The import is committed: called before the app switches to the new company. */
  onImported?: (result: api.ImportCommitResponse) => void;
}

export function ImportWizard({ initialSource, onExit, exitLabel = "Back", onImported }: ImportWizardProps) {
  const { me, refresh } = useAuth();
  const [step, setStep] = useState<Step>(initialSource ? "upload" : "source");
  const [source, setSource] = useState<ImportSource | null>(initialSource ?? null);
  const chosen = useImportFiles();
  const { files, refused, detected } = chosen;
  const [asOfDate, setAsOfDate] = useState("");
  const [timezone, setTimezone] = useState(() => me?.company?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const [jurisdiction, setJurisdiction] = useState("US-DE");
  const [fiscalYearEnd, setFiscalYearEnd] = useState("12-31");
  const [dateError, setDateError] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  // From the last preview: the date the files suggest.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [commitProblem, setCommitProblem] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending | null>(null);
  const [result, setResult] = useState<api.ImportCommitResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  const [blockedNotice, setBlockedNotice] = useState(false);
  const previewRequest = useRef<AbortController | null>(null);

  // In-app navigation waits while the import runs or its outcome is unknown. The ref changes synchronously, so the
  // finished import can move on at once; a router supports one blocker, and the workspace's isn't mounted here.
  const holding = useRef(false);
  const blocker = useBlocker(useCallback(() => holding.current, []));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    blocker.reset();
    setBlockedNotice(true);
  }, [blocker]);
  useEffect(() => () => previewRequest.current?.abort(), []);
  const elapsed = useElapsed(step === "importing" && sending?.kind === "sending");
  // A new step replaces the button that led to it: focus moves to the step's heading, not to the page's top.
  const stepBox = useRef<HTMLDivElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    const heading = stepBox.current?.querySelector<HTMLElement>("h2");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [step]);

  const chooseSource = (next: ImportSource) => {
    if (next !== source) {
      chosen.clear();
      setSuggestion(null);
    } else {
      chosen.clearRefused();
    }
    setUploadProblem(null);
    setSource(next);
    setChecked(null);
    setStep("upload");
  };

  const add = (picked: readonly File[]) => {
    if (!source) return;
    chosen.add(source, picked);
    setUploadProblem(null);
  };

  const remove = (file: File) => {
    chosen.remove(file);
    setUploadProblem(null);
  };

  const check = async () => {
    if (!source) return;
    if (asOfDate && !DATE.test(asOfDate)) {
      setDateError("Enter a date, or leave it empty.");
      return;
    }
    if (!timezone || jurisdiction.length < 2 || jurisdiction.length > 6 || !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(fiscalYearEnd)) {
      setUploadProblem("Check the company timezone, jurisdiction and fiscal year end.");
      return;
    }
    const problem = filesProblem(source, files);
    if (problem) {
      setUploadProblem(problem);
      return;
    }
    const sentFiles = [...files];
    const sentDate = asOfDate || null;
    const profile = { timezone, jurisdiction, fiscalYearEnd };
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setChecking(true);
    setUploadProblem(null);
    try {
      const answer = await apiRequest(api.routes.previewImport, {
        body: { source, files: sentFiles, ...profile, ...(sentDate ? { asOfDate: sentDate } : {}) },
        signal: controller.signal,
      });
      // Without an entered date the review shows, and the import names, the date the server took from the files.
      const date = sentDate ?? (await storedDate(answer.runId, controller.signal));
      setChecked({ runId: answer.runId, preview: answer.preview, source, files: sentFiles, sentDate, date, profile, key: newIdempotencyKey() });
      setSuggestion(answer.preview.suggestedAsOfDate);
      chosen.remember(sentFiles, answer.preview.detectedFiles);
      setCommitProblem(null);
      setStep("preview");
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setUploadProblem(refusal(error, { not_found: "Checking files isn't available." }));
    } finally {
      if (previewRequest.current === controller) previewRequest.current = null;
      if (!controller.signal.aborted) setChecking(false);
    }
  };

  /** Back to the files (corrected files, or another as-of date): the next check makes a fresh preview. */
  const toUpload = () => {
    setChecked(null);
    setCommitProblem(null);
    chosen.clearRefused();
    setStep("upload");
  };

  const finish = (answer: api.ImportCommitResponse) => {
    holding.current = false;
    setSending(null);
    setResult(answer);
    setStep("done");
    // The import is written: the files (up to about 10 MiB) and their preview aren't needed on the result page.
    chosen.clear();
    setChecked(null);
    onImported?.(answer);
    // The import made a new company: read /api/me again so the app switches to it before its pages open.
    setSwitching(true);
    void refresh().finally(() => setSwitching(false));
  };

  const backToPreview = (message: string) => {
    holding.current = false;
    setSending(null);
    setStep("preview");
    setCommitProblem(message);
  };

  const send = async (run: Checked, date: string) => {
    setSending({ kind: "sending" });
    setBlockedNotice(false);
    try {
      finish(await apiRequest(api.routes.commitImport, {
        params: { runId: run.runId },
        body: { files: run.files, asOfDate: date, ...run.profile },
        idempotencyKey: run.key,
      }));
    } catch (error) {
      if (isAmbiguous(error)) {
        setSending({ kind: "unresolved", message: lostAnswer(error) });
        return;
      }
      // A refusal leaves nothing behind: the preview is shown again with the reason.
      backToPreview(`${refusal(error, { not_found: GONE })} Nothing was imported.`);
    }
  };

  const commit = async () => {
    const run = checked;
    if (!run || !run.preview.canImport || splitProblems(run.preview.problems).errors.length > 0) return;
    holding.current = true;
    setCommitProblem(null);
    setStep("importing");
    setSending({ kind: "sending" });
    // The commit names exactly the date that was reviewed; if the run's date couldn't be read after the preview, now.
    let date = run.date;
    if (date === undefined) {
      try {
        const stored: string | null = (await apiRequest(api.routes.getImportRun, { params: { runId: run.runId } })).asOfDate;
        date = stored;
      } catch (error) {
        backToPreview(`The import didn't start. ${describeError(error, { not_found: GONE })} Nothing was imported.`);
        return;
      }
      setChecked({ ...run, date });
    }
    if (date === null) {
      backToPreview("The files don't say which date they show. Enter the as-of date, check the files again, then import.");
      return;
    }
    await send(run, date);
  };

  const retry = () => {
    if (checked?.date) void send(checked, checked.date);
  };

  /** After a lost answer: the run's status says whether the import finished, failed, or hasn't happened. */
  const checkRun = async () => {
    if (!checked) return;
    setSending({ kind: "checking" });
    setBlockedNotice(false);
    try {
      const run = await apiRequest(api.routes.getImportRun, { params: { runId: checked.runId } });
      if (run.status === "committed" && run.orgId) {
        finish({ orgId: run.orgId, counts: run.counts });
      } else if (run.status === "failed") {
        backToPreview(`The import stopped before it finished, and nothing was added to the cap table. ${run.errorMessage ?? "You can import again."}`);
      } else {
        setSending({ kind: "unresolved", message: "The server hasn't finished this import. If it is still running it finishes on its own: check again in a minute, or try again." });
      }
    } catch (error) {
      setSending({ kind: "unresolved", message: `Couldn't check the import. ${describeError(error)}` });
    }
  };

  const current = STEPS.findIndex(([key]) => key === step);
  let body: ReactNode = null;

  if (step === "source" || !source) {
    body = (
      <Card title="Where is the cap table now?">
        <p className="muted">The import sets up the company in one step: its stakeholders, share classes, equity plans and every holding.</p>
        <ul className="choice-list" aria-label="Sources">
          <ChoiceCard title="In Pulley" actions={<button type="button" className="btn btn-primary btn-sm" onClick={() => chooseSource("pulley")}>Import from Pulley</button>}>
            Export Pulley's standard reports as Excel files and upload them together.
          </ChoiceCard>
          <ChoiceCard
            title="In a spreadsheet"
            actions={<><button type="button" className="btn btn-primary btn-sm" onClick={() => chooseSource("template")}>Import from a spreadsheet</button><TemplateDownloadButton /></>}
          >
            Fill in the Cap Table spreadsheet template, then upload it.
          </ChoiceCard>
        </ul>
        {onExit ? <div className="wiz-foot"><button type="button" className="btn btn-ghost" onClick={onExit}>{exitLabel}</button></div> : null}
      </Card>
    );
  } else if (step === "upload") {
    const back = initialSource ? onExit : () => setStep("source");
    body = (
      <Card title={source === "pulley" ? "Upload Pulley's exports" : "Upload the Cap Table spreadsheet"}>
        <ErrorFocus>
          {source === "pulley" ? (
            <>
              <p>In Pulley, export these reports as Excel files, without renaming their columns, and add them all here:</p>
              <ul className="report-list" aria-label="Pulley reports">
                {PULLEY_REPORTS.map((report) => <li key={report.kind}>{report.label}{report.optional ? <span className="muted"> (optional)</span> : null}</li>)}
              </ul>
            </>
          ) : (
            <>
              <p>Fill in the Cap Table spreadsheet: a row for each stakeholder, share class, equity plan and holding, linked by the IDs you give them. Then upload the workbook.</p>
              <div className="mb-8"><TemplateDownloadButton /></div>
            </>
          )}
          <DropZone source={source} disabled={checking} onFiles={add} />
          {refused.length ? <div className="mt-8"><BlockList items={refused} /></div> : null}
          {files.length ? <FileList files={files} detected={detected} disabled={checking} onRemove={remove} /> : null}
          <div className="import-date">
            <DateField
              label="As-of date"
              value={asOfDate}
              disabled={checking}
              error={dateError}
              onChange={(value) => {
                setAsOfDate(value);
                setDateError(undefined);
              }}
              hint={source === "pulley"
                ? "The date the exports show. Leave it empty to use the date the exports state; the preview says if they state none."
                : "Leave it empty to use the as-of date on the spreadsheet's Company sheet."}
            />
            {!asOfDate && suggestion ? (
              <button type="button" className="btn-link small" onClick={() => setAsOfDate(suggestion)}>Use {formatDate(suggestion)}, the date your files suggest</button>
            ) : null}
          </div>
          {!me?.company ? (
            <div className="form-grid mt-8">
              <TextField label="Company timezone" required value={timezone} disabled={checking} onChange={setTimezone}
                hint="The time zone used for vesting, expirations and scheduled changes." />
              <TextField label="Jurisdiction" required value={jurisdiction} disabled={checking} onChange={setJurisdiction}
                hint="For example, US-DE or GB." />
              <TextField label="Fiscal year end" required value={fiscalYearEnd} disabled={checking} onChange={setFiscalYearEnd}
                placeholder="12-31" hint="Month and day, as MM-DD." />
            </div>
          ) : null}
          {uploadProblem ? <Banner kind="danger" title="The files couldn't be checked">{uploadProblem}</Banner> : null}
          <p className="small muted">Checking reads the files on the server to build a preview; nothing is added to the cap table until you import. Until then the files stay in this browser tab.</p>
          <div className="wiz-foot">
            {back ? <button type="button" className="btn btn-ghost" disabled={checking} onClick={back}>{initialSource ? exitLabel : "Back"}</button> : null}
            <button type="button" className="btn btn-primary" disabled={checking || files.length === 0} onClick={() => void check()}>
              {checking ? "Checking the files…" : "Check the files"}
            </button>
          </div>
          {checking ? <p className="small muted right" role="status">Checking the files…</p> : null}
        </ErrorFocus>
      </Card>
    );
  } else if (step === "preview" && checked) {
    const { preview } = checked;
    // The warnings a file carries but the problems don't list (the spreadsheet's precision warnings) are shown with them.
    const problems = [...preview.problems, ...fileWarnings(preview)];
    const { errors } = splitProblems(problems);
    const importable = preview.canImport && errors.length === 0;
    const date = checked.date === undefined
      ? "As of the date your files give"
      : checked.date === null ? "No as-of date yet" : `As of ${formatDate(checked.date)}${checked.sentDate ? "" : ", from your files"}`;
    body = (
      <>
        <Card title="Review the import">
          <p className="import-summary">
            From {checked.source === "pulley" ? "Pulley's exports" : "the Cap Table spreadsheet"} · {plural(checked.files.length, "file")} · {date} · Currency {preview.currency}{" "}
            <button type="button" className="btn-link" onClick={toUpload}>Change the date</button>
          </p>
          <DetectedFiles files={preview.detectedFiles} />
          {commitProblem ? <Banner kind="danger" title="Nothing was imported">{commitProblem}</Banner> : null}
          <ProblemSections problems={problems} canImport={preview.canImport} />
        </Card>
        <OpeningBalances balances={preview.openingBalances} />
        <Assumptions assumptions={preview.assumptions} />
        <ImportTotals totals={preview.totals} counts={preview.counts} source={checked.source} />
        <div className="wiz-foot">
          <button type="button" className="btn btn-ghost" onClick={toUpload}>Upload corrected files</button>
          <button type="button" className="btn btn-primary" disabled={!importable} aria-describedby={importable ? undefined : "import-blocked"} onClick={() => void commit()}>
            Import
          </button>
        </div>
        {importable ? null : (
          <p className="small muted right" id="import-blocked">
            {errors.length ? `Import is off until the ${plural(errors.length, "problem")} above ${errors.length === 1 ? "is" : "are"} fixed.` : "This preview can't be imported. Upload corrected files."}
          </p>
        )}
      </>
    );
  } else if (step === "importing" && checked) {
    const { counts } = checked.preview;
    body = (
      <Card title="Importing the cap table">
        {sending?.kind === "unresolved" ? (
          <Banner
            kind="danger"
            title="The import's outcome isn't known yet"
            action={
              <span className="row nowrap">
                <button type="button" className="btn btn-ghost btn-sm" onClick={retry}>Try again</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void checkRun()}>Check the import</button>
              </span>
            }
          >
            {sending.message} The import may have finished anyway. Check it, or try again: if it finished, the server answers with that result instead of importing twice.
          </Banner>
        ) : (
          <div className="import-progress">
            <progress aria-label="Import progress" />
            <p role="status">
              {sending?.kind === "checking" ? "Checking the import…" : `Importing ${plural(counts.stakeholders, "stakeholder")}, ${plural(counts.securities, "security", "securities")} and ${plural(counts.transactions, "transaction")}…`}
            </p>
            {sending?.kind === "sending" ? <p className="small muted">This can take a few minutes for a large company. Running for {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}.</p> : null}
          </div>
        )}
        <p className="small">Keep this page open until the import finishes.</p>
        {blockedNotice ? <p className="err-inline" role="alert">The import is still running. Stay on this page until it finishes.</p> : null}
      </Card>
    );
  } else if (step === "done" && result) {
    const company = me?.company?.id === result.orgId ? me.company : null;
    body = (
      <Card title="Import complete">
        <Banner kind="ok" title="The cap table is imported">{company ? `${company.displayName} is set up with the records below.` : "The company is set up with the records below."}</Banner>
        <ImportCounts counts={result.counts} label="Imported" />
        <div className="wiz-foot">
          {switching ? (
            <span className="small muted" role="status">Opening the company…</span>
          ) : (
            <>
              <Link className="btn btn-ghost" to={company ? `/companies/${company.id}/dashboard` : "/"}>Go to the dashboard</Link>
              <Link className="btn btn-primary" to={company ? `/companies/${company.id}/captable` : "/"}>Open the cap table</Link>
            </>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="wiz-body rail import-wizard">
      <ol className="steps-rail" aria-label="Import steps">
        {STEPS.map(([key, label], index) => (
          <li key={key} className={index < current ? "st done" : index === current ? "st cur" : "st"} aria-current={index === current ? "step" : undefined}>
            <span className="o" aria-hidden="true" />
            <span>{label}</span>
          </li>
        ))}
      </ol>
      <div className="import-step" ref={stepBox}>{body}</div>
    </div>
  );
}
