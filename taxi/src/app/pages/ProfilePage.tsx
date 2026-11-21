import { Link, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { canPrepare, routes } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { apiRequest } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { ResourceView } from "../components/Feedback.tsx";
import { Page, PageHead } from "../components/Page.tsx";
import { PeopleEditor } from "../components/PeopleEditor.tsx";
import { useResource } from "../lib/useResource.ts";

// `/profile`: everyone in the profile, the same every year. Pages that send someone here to add a person pass
// `?back=` (Start a year, step 1 of a year), and the page offers the way back.

/** Where "Back" may lead: only a page of the returns, never another site. */
export function backTarget(value: string | null): { to: string; label: string } | null {
  if (!value || !/^\/returns(?:[/?]|$)/.test(value)) return null;
  const start = /[?&]start=(\d{4})/.exec(value)?.[1];
  if (start) return { to: value, label: `Back to Start ${start}` };
  const year = /^\/returns\/(\d{4})/.exec(value)?.[1];
  return { to: value, label: year ? `Back to ${year}` : "Back to returns" };
}

export function ProfilePage() {
  const me = useMe();
  const [search] = useSearchParams();
  const back = backTarget(search.get("back"));
  const resource = useResource("people", (signal) => apiRequest(routes.listPeople, { signal }));
  return (
    <Page title="Profile" crumbs={[["Profile"]]}>
      <PageHead
        title="Profile"
        actions={
          back ? (
            <Button asChild variant="outline">
              <Link to={back.to}>
                <ArrowLeft aria-hidden="true" />
                {back.label}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <ResourceView resource={resource}>
          {(data) => (
            <PeopleEditor
              people={data.people}
              editable={canPrepare(me)}
              onChanged={async () => {
                if (resource.status === "ready") resource.replace(await apiRequest(routes.listPeople, {}));
              }}
            />
          )}
        </ResourceView>
        <Card size="sm">
          <CardHeader>
            <CardTitle>
              <h2 className="text-sm font-semibold">What we don't ask for</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            No SIN, home address or bank details. You write them on the paper return when you sign it. Uploaded files are kept as they are,
            so what a slip prints (often your SIN and address) is stored with the file until you delete it.
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
