import { useState } from "react";
import type { api } from "#shared";
import { Icon } from "../../components/Icon.tsx";
import { Card, PageHead, SectionTitle } from "../../components/Page.tsx";
import { DocumentCards, PortalLink, PortalPage, PortalResourceView } from "../../components/PortalParts.tsx";
import { usePortal, type PortalScope } from "../../components/PortalWorkspace.tsx";
import { documentKindLabel } from "../../lib/labels.ts";
import { useResource } from "../../lib/useResource.ts";

// Documents: the holder's own documents (agreements, notices of exercise, migrated certificates,
// 83(b) proofs) and the company resources every holder may open (plan, notice form, FAQ, privacy notice). The portal
// lists only what the server marks visible to this holder (one linked holder, or a company resource);
// downloads go through the audited portal route. The company's designated privacy notice leads the company resources,
// marked as such. Each of the holder's own documents names the holdings it belongs to, from the documents each holding
// lists, and a search narrows the page as the holder types.

/** The display ids of the holder's securities each document is linked to (the overview's per-security documents). */
function holdingsByDocument(holdings: PortalScope["holdings"]): Map<string, string[]> {
  const byDocument = new Map<string, string[]>();
  for (const security of holdings.flatMap((holding) => holding.securities)) {
    for (const document of security.documents) {
      const ids = byDocument.get(document.id) ?? [];
      if (!ids.includes(security.displayId)) ids.push(security.displayId);
      byDocument.set(document.id, ids);
    }
  }
  for (const ids of byDocument.values()) ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return byDocument;
}

/** Newest first, an imported document by its original upload. */
function newestFirst(documents: readonly api.PortalDocument[]): api.PortalDocument[] {
  const date = (document: api.PortalDocument) => document.sourceCreatedAt ?? document.createdAt;
  return [...documents].sort((a, b) => date(b) - date(a));
}

export function PortalDocumentsPage() {
  const portal = usePortal();
  const documents = useResource((signal) => portal.source.documents(signal), [portal.source.key]);
  const [query, setQuery] = useState("");
  const holdings = holdingsByDocument(portal.holdings);
  const holdingsOf = (document: api.PortalDocument) => holdings.get(document.id) ?? [];
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (document: api.PortalDocument) => {
    const text = [document.filename, documentKindLabel(document.kind), ...holdingsOf(document)].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  };
  return (
    <PortalPage title="Documents" crumb="Documents">
      <Card>
        <PageHead title="Documents" />
        <PortalResourceView resource={documents} what="Documents">
          {(data) => {
            const shown = newestFirst(data).filter(matches);
            const filtered = words.length > 0;
            return (
              <>
                <label className="dt-search">
                  <Icon name="search" />
                  <span className="sr-only">Search documents</span>
                  <input type="search" value={query} placeholder="Search by name, kind or grant…" autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
                </label>
                <SectionTitle>My documents</SectionTitle>
                <DocumentCards
                  documents={shown.filter((document) => document.scope === "mine")}
                  holdingsOf={holdingsOf}
                  empty={filtered ? "None of your documents match." : "No documents of yours have been shared here yet."}
                />
                <SectionTitle>Company resources</SectionTitle>
                <DocumentCards
                  documents={shown.filter((document) => document.scope === "company")}
                  empty={filtered ? "No company resources match." : "No company resources yet."}
                />
                <p className="small muted mt-12">See also <PortalLink to="how-to-exercise">How to exercise</PortalLink>.</p>
              </>
            );
          }}
        </PortalResourceView>
      </Card>
    </PortalPage>
  );
}
