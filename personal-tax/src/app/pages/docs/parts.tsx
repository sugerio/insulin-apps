import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";

// The pieces the in-app Docs are written with. Each topic is static TSX: a title, a one-line summary and sections of
// ordinary markup, with no parser and no data from the server, so the same pages serve every role.

export const TOPIC_SLUGS = ["getting-started", "household", "tax-basics", "glossary"] as const;
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
  /** Where the topic list shows it: using the app, or Canadian personal tax in general. */
  group: "app" | "tax";
  /** Tax matters: the topic opens with the note that it is general information, not advice. */
  generalInformation?: true;
  /** The glossary's sections are letters: "On this page" lists them on one line. */
  compactContents?: true;
  sections: readonly DocSection[];
}

/** Where the docs are: `/docs`. */
export const DocsBaseContext = createContext("/docs");

/** The address of a topic, or of a section in it, in the reader's docs. */
export function useDocHref(): (topic: TopicSlug, section?: string) => string {
  const base = useContext(DocsBaseContext);
  return (topic, section) => `${base}/${topic}${section ? `#${section}` : ""}`;
}

/** A link to another topic of the docs, or to a section of one. */
export function DocLink({ to, section, children }: { to: TopicSlug; section?: string; children: ReactNode }) {
  const href = useDocHref();
  return <Link className="font-medium underline underline-offset-4 hover:text-primary" to={href(to, section)}>{children}</Link>;
}

/** An id for a heading or a glossary term: "Notice of assessment" → "notice-of-assessment", "RRSP (registered…)" → "rrsp-registered…". */
export function anchorId(text: string): string {
  return text.toLowerCase().replace(/[()'’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** How a general idea shows up in Personal Tax, at the end of a tax section. */
export function InApp({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 rounded-lg bg-muted px-4 py-3"><b>In Personal Tax:</b> {children}</p>;
}

/** A worked example, set apart from the text around it. */
export function Example({ title = "Example", children }: { title?: string; children: ReactNode }) {
  return (
    <div className="my-1 mb-3.5 rounded-r-lg border-l-4 border-primary bg-muted/50 px-4 py-3.5 [&>p:last-child]:mb-0">
      <p className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {children}
    </div>
  );
}

/** A small table: the first cell of each row heads it. */
export function DocTable({ label, columns, rows }: { label: string; columns: readonly string[]; rows: readonly (readonly ReactNode[])[] }) {
  return (
    <div className="my-1 mb-3.5 overflow-hidden rounded-lg border bg-card">
      <Table aria-label={label}>
        <TableHeader className="bg-muted/50">
          <TableRow>{columns.map((column) => <TableHead key={column} scope="col" className="h-auto px-3.5 py-2.5 text-xs text-muted-foreground">{column}</TableHead>)}</TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index} className="hover:bg-transparent">
              {row.map((cell, column) => (column === 0
                ? <TableHead key={column} scope="row" className="h-auto px-3.5 py-2.5 align-top whitespace-normal">{cell}</TableHead>
                : <TableCell key={column} className="px-3.5 py-2.5 align-top whitespace-normal">{cell}</TableCell>))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
