import { useState, type ReactNode } from "react";
import type { api } from "#shared";
import { DASH, formatDate, plural } from "../lib/format.ts";
import {
  countRows, fileKindLabel, isPrecisionWarning, locationLabel, reconciliationGroups, sentenceCase, splitProblems, type ImportSource, type LineGroup,
} from "../lib/imports.ts";
import { useAdminFormat } from "../lib/useAdminFormat.ts";
import { Badge, Banner } from "./Feedback.tsx";
import { Icon } from "./Icon.tsx";
import { Card } from "./Page.tsx";

// The import preview, as the server computed it from the uploaded files: what each file was recognized as, the
// problems (blocking ones first, each with its place in the files and the fix in its sentence), the warnings, the
// opening balances that stand in for history the files can't express, the assumptions made, and the totals the import
// produces next to the source's own figures. The browser only counts lines and formats the figures it is given.

/** Long lists show this many lines until the admin asks for all of them. */
const LIST_LIMIT = 50;

function useLimit<T>(items: readonly T[]): { shown: readonly T[]; more: ReactNode } {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, LIST_LIMIT);
  const more = items.length > shown.length
    ? <button type="button" className="btn-link small mt-8" onClick={() => setAll(true)}>Show all {items.length.toLocaleString("en-US")}</button>
    : null;
  return { shown, more };
}

export function DetectedFiles({ files }: { files: readonly api.ImportDetectedFile[] }) {
  if (!files.length) return null;
  return (
    <ul className="import-files" aria-label="Files checked">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className={file.kind === null ? "bad" : "ok"}>
          <Icon name={file.kind === null ? "alert" : "checkCircle"} />
          <span className="if-name">{file.name}</span>
          <span className="if-kind">{fileKindLabel(file.kind)}</span>
        </li>
      ))}
    </ul>
  );
}

function ProblemList({ problems, label, tone }: { problems: readonly api.ImportProblem[]; label: string; tone: "error" | "warning" }) {
  const { shown, more } = useLimit(problems);
  return (
    <>
      <ol className={`problem-list ${tone}`} aria-label={label}>
        {shown.map((problem, index) => {
          const where = locationLabel(problem);
          return (
            <li className="problem" key={index}>
              {where ? <span className="p-where">{where}</span> : null}
              <span className="p-what">{problem.message}</span>
            </li>
          );
        })}
      </ol>
      {more}
    </>
  );
}

/**
 * Blocking problems, then warnings. With no blocking problem left, a plain note says the import can go ahead, unless the
 * server still couldn't prepare one from these files.
 */
export function ProblemSections({ problems, canImport }: { problems: readonly api.ImportProblem[]; canImport: boolean }) {
  const { errors, warnings } = splitProblems(problems);
  return (
    <>
      {errors.length ? (
        <section className="import-section" aria-labelledby="import-errors">
          <h3 id="import-errors">Problems to fix <span className="cnt">{errors.length.toLocaleString("en-US")}</span></h3>
          <p className="small muted">Each one blocks the import. Fix them in your files at the place shown, then upload the corrected files.</p>
          <ProblemList problems={errors} label="Problems to fix" tone="error" />
        </section>
      ) : canImport ? (
        <Banner kind="ok" title="Nothing blocks the import">Check the warnings, opening balances and totals below, then import.</Banner>
      ) : (
        <Banner kind="danger" title="These files can't be imported">The server couldn't prepare an import from them. Upload corrected files and check them again.</Banner>
      )}
      {warnings.length ? (
        <section className="import-section" aria-labelledby="import-warnings">
          <h3 id="import-warnings">Warnings <span className="cnt">{warnings.length.toLocaleString("en-US")}</span></h3>
          <p className="small muted">Warnings don't stop the import. Make sure each one is what you expect.</p>
          {warnings.some((warning) => isPrecisionWarning(warning.message)) ? (
            <p className="small muted">Excel keeps 15 significant digits, so a longer number may already be rounded in the file: check it against your records.</p>
          ) : null}
          <ProblemList problems={warnings} label="Warnings" tone="warning" />
        </section>
      ) : null}
    </>
  );
}

export function OpeningBalances({ balances }: { balances: readonly api.ImportOpeningBalance[] }) {
  const { shown, more } = useLimit(balances);
  if (!balances.length) return null;
  return (
    <Card title="Opening balances" right={<span className="cnt">{balances.length.toLocaleString("en-US")}</span>}>
      <p className="small muted">The files show where these securities stand today but not every step that led there. Each is imported as a starting balance on the date shown, for the reason given.</p>
      <div className="tbl-scroll">
        <table className="tbl dense" aria-label="Opening balances">
          <thead>
            <tr><th scope="col">Security</th><th scope="col">Date</th><th scope="col">Why</th><th scope="col">Where</th></tr>
          </thead>
          <tbody>
            {shown.map((balance, index) => (
              <tr key={`${balance.displayId}-${index}`}>
                <td className="nowrap">{balance.displayId}</td>
                <td className="nowrap">{formatDate(balance.date)}</td>
                <td className="wrap">{balance.reason}</td>
                <td className="wrap small">{locationLabel(balance) ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more}
    </Card>
  );
}

export function Assumptions({ assumptions }: { assumptions: readonly string[] }) {
  const { shown, more } = useLimit(assumptions);
  if (!assumptions.length) return null;
  return (
    <Card title="Assumptions" right={<span className="cnt">{assumptions.length.toLocaleString("en-US")}</span>}>
      <p className="small muted">Where the files leave something open, the import makes these choices. You can review them now; nothing here blocks the import.</p>
      <ul className="assumption-list">
        {shown.map((assumption, index) => <li key={index}>{assumption}</li>)}
      </ul>
      {more}
    </Card>
  );
}

/** What the import adds, as a definition list (also the result's summary). */
export function ImportCounts({ counts, label }: { counts: api.ImportCounts; label: string }) {
  return (
    <dl className="import-counts" aria-label={label}>
      {countRows(counts).map(([name, count]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{count.toLocaleString("en-US")}</dd>
        </div>
      ))}
    </dl>
  );
}

function ComparisonGroup({ group, sourceName }: { group: LineGroup; sourceName: string }) {
  const format = useAdminFormat();
  return (
    <details className="adv mt-8" open={group.mismatches > 0 || group.lines.length <= 8}>
      <summary>
        {group.title}
        <span className="small muted"> · {plural(group.lines.length, "total")} · {group.mismatches ? `${group.mismatches.toLocaleString("en-US")} differ` : "all match"}</span>
      </summary>
      <div className="adv-b tbl-scroll">
        <table className="tbl dense" aria-label={`${group.title} compared`}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Total</th>
              <th scope="col" className="num">{sourceName}</th>
              <th scope="col" className="num">Imported</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {group.lines.map((line, index) => (
              <tr key={`${line.sourceId ?? line.name}-${line.metric}-${index}`}>
                <td>{line.name}</td>
                <td>{sentenceCase(line.metric)}</td>
                <td className="num">{format.shares(line.uploaded)}</td>
                <td className="num">{line.app === null ? DASH : format.shares(line.app)}</td>
                <td>{line.matches ? <Badge tone="green">Matches</Badge> : <Badge tone="red">Differs</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * The totals: what is imported, the company's figures after the import, and every total the source states next to the
 * same total computed from the imported records (company, classes, plans, holders, then securities).
 */
export function ImportTotals({ totals, counts, source }: { totals: api.ImportTotals; counts: api.ImportCounts; source: ImportSource }) {
  const format = useAdminFormat();
  const groups = reconciliationGroups(totals.reconciliation);
  const lines = totals.reconciliation.length;
  const differ = groups.reduce((sum, group) => sum + group.mismatches, 0);
  const sourceName = source === "pulley" ? "Pulley" : "Spreadsheet";
  const whose = source === "pulley" ? "Pulley's reports" : "your spreadsheet";
  return (
    <Card title="Totals">
      <h3 className="section-title">What will be imported</h3>
      <ImportCounts counts={counts} label="What will be imported" />
      <h3 className="section-title">The company after the import</h3>
      <dl className="import-counts" aria-label="The company after the import">
        <div><dt>Fully diluted shares</dt><dd>{format.shares(totals.app.fullyDiluted)}</dd></div>
        <div><dt>Issued and outstanding shares</dt><dd>{format.shares(totals.app.issuedAndOutstanding)}</dd></div>
      </dl>
      <h3 className="section-title">Compared with {whose}</h3>
      {lines ? (
        <>
          <p className="small muted">
            {differ
              ? `${differ.toLocaleString("en-US")} of ${plural(lines, "total")} differ from ${whose}; each one is also listed as a problem above.`
              : `All ${plural(lines, "total")} that ${whose} state match what the import produces.`}
          </p>
          {groups.map((group) => <ComparisonGroup key={group.scope} group={group} sourceName={sourceName} />)}
        </>
      ) : (
        <p className="small muted">
          {source === "pulley" ? "Pulley's reports stated no totals to compare." : "The spreadsheet states no totals to compare: check the figures above against your own records."}
        </p>
      )}
    </Card>
  );
}
