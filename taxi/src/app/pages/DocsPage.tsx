import { useParams } from "react-router";
import { Docs } from "../components/Docs.tsx";
import { Page } from "../components/Page.tsx";
import { docTopic } from "./docs/topics.ts";
import { NotFoundPage } from "./Pages.tsx";

/** `/docs/:topic?`: open to every role, whatever they can see of the returns. */
export function DocsPage() {
  const topic = docTopic(useParams().topic);
  if (!topic) return <NotFoundPage />;
  return (
    <Page title={`${topic.title} — Docs`} crumbs={[["Docs", "/docs"], [topic.title]]} wide>
      <Docs base="/docs" topic={topic} />
    </Page>
  );
}
