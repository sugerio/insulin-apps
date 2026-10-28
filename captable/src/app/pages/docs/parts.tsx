import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router";

// The pieces the in-app Docs are written with. Each topic is static TSX: a title, a one-line summary and sections of
// ordinary markup, with no parser and no data from the server, so the same pages serve owners, editors and holders.
// Links between topics go through DocLink, which knows where the reader's docs live: in the admin workspace, in the
// holder's portfolio, or on their own pages before a company exists.

export const TOPIC_SLUGS = ["getting-started", "importing", "everyday-tasks", "for-stakeholders", "equity-basics", "glossary"] as const;
export type TopicSlug = (typeof TOPIC_SLUGS)[number];

export interface DocSection {
  /** The heading's id: the "On this page" list and links from other topics point at it. */
  id: string;
  title: string;
  body: ReactNode;
}

export interface DocTopic {
  slug: TopicSlug;
  title: string;
  /** One sentence under the title. */
  summary: string;
  /** Where the topic list shows it: using the app, or equity and cap tables in general. */
  group: "app" | "equity";
  /** Equity, tax and legal matters: the topic opens with the note that it is general information, not advice. */
  generalInformation?: true;
  /** The glossary's sections are letters: "On this page" lists them on one line. */
  compactContents?: true;
  sections: readonly DocSection[];
}

/** Where the docs are for the reader: `/companies/:orgId/docs`, `/portfolio/:orgId/docs` or `/docs`. */
export const DocsBaseContext = createContext("/docs");

/** The address of a topic, or of a section in it, in the reader's docs. */
export function useDocHref(): (topic: TopicSlug, section?: string) => string {
  const base = useContext(DocsBaseContext);
  return (topic, section) => `${base}/${topic}${section ? `#${section}` : ""}`;
}

/** A link to another topic of the docs, or to a section of one. */
export function DocLink({ to, section, children }: { to: TopicSlug; section?: string; children: ReactNode }) {
  const href = useDocHref();
  return <Link to={href(to, section)}>{children}</Link>;
}

/** An id for a heading or a glossary term: "Fully diluted" → "fully-diluted", "83(b) election" → "83b-election". */
export function anchorId(text: string): string {
  return text.toLowerCase().replace(/[()'’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** How a general idea shows up in Cap Table, at the end of an equity section. */
export function InApp({ children }: { children: ReactNode }) {
  return <p className="docs-inapp"><b>In Cap Table:</b> {children}</p>;
}

/** A worked example, set apart from the text around it. */
export function Example({ title = "Example", children }: { title?: string; children: ReactNode }) {
  return (
    <div className="docs-example">
      <p className="docs-example-t">{title}</p>
      {children}
    </div>
  );
}

/** A small table: the first cell of each row heads it. */
export function DocTable({ label, columns, rows }: { label: string; columns: readonly string[]; rows: readonly (readonly ReactNode[])[] }) {
  return (
    <div className="tbl-scroll docs-table">
      <table className="tbl" aria-label={label}>
        <thead>
          <tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (column === 0 ? <th key={column} scope="row">{cell}</th> : <td key={column}>{cell}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
