import { useState, type ReactNode } from "react";
import { CircleCheck, Info, PiggyBank, TriangleAlert } from "lucide-react";
import { canPrepare, routes, type HintView } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { formatMoney } from "../lib/format.ts";
import { useResource } from "../lib/useResource.ts";
import { Banner, ResourceView } from "./Feedback.tsx";
import { useYear } from "./YearFrame.tsx";

// The hints of one return (rules/<country>/<year>/hints.yaml), loaded again whenever the year changes: savings to
// apply, with what each saves for the household, and things to know. Applying saves the hint's answers; a decision
// can be undone.

const ORDER: Record<HintView["kind"], number> = { saving: 0, warning: 1, info: 2 };
const ICON = { saving: PiggyBank, warning: TriangleAlert, info: Info } as const;

export function HintList({ personId }: { personId: string }) {
  const { year } = useYear();
  const hints = useResource(`hints-${year.year}-${year.revision}`, (signal) => apiRequest(routes.listHints, { params: { year: year.year }, signal }));
  return <ResourceView resource={hints}>{(data) => <Hints hints={data.hints.filter((hint) => hint.personId === personId)} personId={personId} />}</ResourceView>;
}

function Hints({ hints, personId }: { hints: HintView[]; personId: string }) {
  const me = useMe();
  const editable = canPrepare(me);
  const { year, replace, reload } = useYear();
  const [state, setState] = useState<{ status: "idle" } | { status: "saving"; hint: string } | { status: "error"; error: unknown }>({ status: "idle" });

  async function decide(hint: HintView, decision: "accept" | "dismiss" | "undo") {
    setState({ status: "saving", hint: hint.id });
    try {
      replace(await apiRequest(routes.decideHint, { params: { year: year.year, hint: hint.id }, body: { revision: year.revision, personId, decision } }));
      setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  const open = hints
    .filter((hint) => hint.state === "open")
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || Number(b.effect ?? 0) - Number(a.effect ?? 0));
  const applied = hints.filter((hint) => hint.state === "applied");
  const dismissed = hints.filter((hint) => hint.state === "dismissed");
  const busy = state.status === "saving";
  const stale = state.status === "error" && state.error instanceof ApiError && state.error.status === 409;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Check and save</h2>
        </CardTitle>
        <CardDescription>Each saving is worked out on both returns, with and without the change. Applying it changes your answers; you can undo it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {open.length === 0 && applied.length === 0 ? <p className="text-sm text-muted-foreground">Nothing to change on this return.</p> : null}
        {open.length > 0 || applied.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Hints">
            {open.map((hint) => (
              <HintItem key={hint.id} hint={hint}>
                {editable ? (
                  <div className="flex flex-wrap gap-2">
                    {hint.kind === "saving" ? (
                      <Button size="sm" onClick={() => void decide(hint, "accept")} disabled={busy} aria-label={`Apply: ${hint.title}`}>
                        Apply
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => void decide(hint, "dismiss")} disabled={busy} aria-label={`Dismiss: ${hint.title}`}>
                      Dismiss
                    </Button>
                  </div>
                ) : null}
              </HintItem>
            ))}
            {applied.map((hint) => (
              <HintItem key={hint.id} hint={hint}>
                {editable ? (
                  <div>
                    <Button size="sm" variant="outline" onClick={() => void decide(hint, "undo")} disabled={busy} aria-label={`Undo: ${hint.title}`}>
                      Undo
                    </Button>
                  </div>
                ) : null}
              </HintItem>
            ))}
          </ul>
        ) : null}
        {dismissed.length > 0 ? (
          <section aria-label="Dismissed hints" className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">Dismissed</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {dismissed.map((hint) => (
                <li key={hint.id} className="flex flex-wrap items-center justify-between gap-x-3">
                  <span className="text-muted-foreground">{hint.title}</span>
                  {editable ? (
                    <Button size="sm" variant="ghost" onClick={() => void decide(hint, "undo")} disabled={busy} aria-label={`Show again: ${hint.title}`}>
                      Show again
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {stale ? (
          <Banner kind="error" title="Someone else changed this year" action={<Button variant="outline" size="sm" onClick={reload}>Reload</Button>}>
            {describeError(state.error)}
          </Banner>
        ) : state.status === "error" ? (
          <Banner kind="error" title="That didn't work">{describeError(state.error)}</Banner>
        ) : null}
      </CardContent>
    </Card>
  );
}

function HintItem({ hint, children }: { hint: HintView; children: ReactNode }) {
  const applied = hint.state === "applied";
  const Glyph = applied ? CircleCheck : ICON[hint.kind];
  return (
    <li className="flex gap-3 p-4" aria-label={hint.title}>
      <Glyph
        className={cn("mt-0.5 size-4 shrink-0", applied || hint.kind === "saving" ? "text-emerald-600 dark:text-emerald-400" : hint.kind === "warning" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-sm font-medium">{hint.title}</h3>
          {hint.kind === "saving" && hint.effect !== null ? (
            <Badge variant="secondary" className="bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              {applied ? "Saved" : "Saves"} {formatMoney(hint.effect)}
            </Badge>
          ) : null}
        </div>
        {applied ? <p className="text-xs text-muted-foreground">Applied to your answers.</p> : <p className="text-xs text-muted-foreground">{hint.text}</p>}
        {hint.amount || (hint.effectLabel && hint.effect !== null) ? (
          <dl className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[max-content_max-content]">
            {hint.amount ? (
              <>
                <dt className="text-muted-foreground">{hint.amount.label}</dt>
                <dd className="tabular-nums">{formatMoney(hint.amount.value)}</dd>
              </>
            ) : null}
            {hint.effectLabel && hint.effect !== null ? (
              <>
                <dt className="text-muted-foreground">{hint.effectLabel}</dt>
                <dd className="tabular-nums">{formatMoney(hint.effect.replace(/^-/, ""))}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {children}
      </div>
    </li>
  );
}
