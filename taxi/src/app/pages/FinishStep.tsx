import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { FileDown } from "lucide-react";
import { formsToAdd, printBlockers, spouseOf, type Estimate, type FormLanguage, type SlipList, type Step } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { ResultLine } from "../components/EstimateCard.tsx";
import { HintList } from "../components/HintList.tsx";
import { saveFile } from "../api/client.ts";
import { RefusedBanner, ResourceView } from "../components/Feedback.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { STEP_LABELS, stepPath, useReturn, useYear } from "../components/YearFrame.tsx";
import { formatMoney } from "../lib/format.ts";
import { useEstimate, useSlips } from "../lib/useYearData.ts";
import { Evaluation } from "../shared/engine/evaluate.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 6, `/returns/:year/:personId/finish`: the open return's refund or balance owing, its key lines with why each is
// what it is (worked out in the browser with the same engine), what still needs a look before filing, and the return's
// hints: savings to apply and things to know.

export function FinishStep() {
  const { person } = useReturn();
  const estimate = useEstimate();
  const slips = useSlips();
  return (
    <StepLayout step="finish" title="Your results" estimate={false}>
      <ResourceView resource={estimate}>
        {(data) => <ResourceView resource={slips}>{(slipList) => <Results estimate={data} slips={slipList} />}</ResourceView>}
      </ResourceView>
      <HintList personId={person.id} />
    </StepLayout>
  );
}

function Results({ estimate, slips }: { estimate: Estimate; slips: SlipList }) {
  const { year } = useYear();
  const { person: owner } = useReturn();
  const rules = rulesFor(year.year)!;
  const evaluation = useMemo(() => new Evaluation(rules, estimate.input), [rules, estimate.input]);
  const person = estimate.result.people.find((each) => each.personId === owner.id);
  if (!person) return <p className="text-sm text-muted-foreground">Nothing to work out yet.</p>;
  const line = (id: string) => person.lines.find((each) => each.id === id);
  const refund = line("T1.48400");
  const owing = line("T1.48500");
  // A resident of Quebec files two returns: the result has the Quebec refund and balance (TP-1 lines 478 and 479) too.
  const quebecRefund = line("TP1.478");
  const quebecOwing = line("TP1.479");
  const results = new Set(["T1.48400", "T1.48500", "TP1.478", "TP1.479"]);
  /** The step that asks a question: its module's, Personal info for facts about the person. */
  const stepOfQuestion = (id: string): Step => {
    const module = rules.questions.get(id)?.module;
    return module === "income" || module === "deductions" || module === "credits" ? module : "personal";
  };
  const other = spouseOf(estimate.result.people, owner.id);
  const spouse = other ? { name: year.people.find((each) => each.id === other.personId)?.name ?? "Your spouse", result: other } : undefined;
  const checks = groupUnanswered(
    printBlockers({ rules, issues: year.issues, answers: estimate.input.answers, slips: slips.slips }, person, spouse).map((blocker) => ({
      text: blocker.text,
      personId: blocker.personId ?? owner.id,
      step: blocker.confirm ? ("confirm" as const) : blocker.issue ? ("personal" as const) : blocker.question ? stepOfQuestion(blocker.question) : null,
      ask: blocker.question && blocker.unanswered ? (rules.questions.get(blocker.question)?.ask ?? null) : null,
    })),
    (personId) => (personId === owner.id ? "" : `${spouse?.name ?? "Your spouse"}'s return: `),
  );
  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        {quebecRefund && quebecOwing ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Headline title="Federal" refund={refund?.value ?? null} owing={owing?.value ?? null} />
            <Headline title="Quebec" refund={quebecRefund.value} owing={quebecOwing.value} />
          </div>
        ) : (
          <Headline refund={refund?.value ?? null} owing={owing?.value ?? null} />
        )}
        <ul className="flex flex-col" aria-label="Key lines">
          {person.lines
            .filter((each) => !results.has(each.id))
            .map((each) => (
              <ResultLine key={each.id} line={each} explain={() => evaluation.explain(person.personId, `line.${each.id}`)} rules={rules} />
            ))}
        </ul>
        {checks.length > 0 ? (
          <section aria-label="Before you file" className="flex flex-col gap-1.5">
            <h2 className="text-sm font-medium">Before you file</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {checks.map((check) => (
                <li key={check.text} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="min-w-0 text-muted-foreground wrap-anywhere">{check.text}</span>
                  {check.step ? (
                    <Link className="text-xs underline underline-offset-2" to={stepPath(year.year, check.personId, check.step)}>
                      Go to the step
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <Download
          ready={checks.length === 0}
          quebec={Boolean(quebecRefund && quebecOwing)}
          toAdd={formsToAdd(evaluation, owner.id)}
          href={`/api/years/${year.year}/returns/${owner.id}/forms`}
          fileName={`Taxi ${year.year} return - ${owner.name}.pdf`}
        />
      </CardContent>
    </Card>
  );
}

/** A return's refund or balance owing; `title` names the return when there are two (federal and Quebec). */
function Headline({ title, refund, owing }: { title?: string; refund: string | null; owing: string | null }) {
  if (refund === null || owing === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {title ? `The ${title} refund or balance owing` : "The refund or balance owing"} can't be worked out yet: see below.
      </p>
    );
  }
  const isRefund = !Number(owing);
  const label = isRefund ? "Refund" : "Balance owing";
  return (
    <div className="rounded-lg bg-muted/50 px-4 py-3">
      <p className="text-sm text-muted-foreground">{title ? `${title} ${label.toLowerCase()}` : label}</p>
      <p className="text-2xl font-semibold tabular-nums">{formatMoney(isRefund ? refund : owing)}</p>
    </div>
  );
}

/**
 * The return on the CRA's forms (and, for a resident of Quebec, on Revenu Québec's TP-1 after them), with its
 * worksheet: only a finished return can be printed. Revenu Québec's forms print in English or in French. `toAdd` are
 * the forms the return needs that aren't printed. The PDF is fetched here and saved, so the page can say it is being
 * prepared (a first print downloads each official form) and why it couldn't be.
 */
function Download({
  ready,
  quebec,
  toAdd,
  href,
  fileName,
}: {
  ready: boolean;
  quebec: boolean;
  toAdd: { form: string; why: string }[];
  href: string;
  fileName: string;
}) {
  const [language, setLanguage] = useState<FormLanguage>("en");
  const [state, setState] = useState<{ status: "idle" | "preparing" } | { status: "error"; error: unknown }>({ status: "idle" });
  const languageLabel = useId();

  async function download() {
    const query = new URLSearchParams({ ...(quebec && language === "fr" ? { language } : {}), download: "1" });
    setState({ status: "preparing" });
    try {
      await saveFile(`${href}?${query}`, fileName);
      setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }
  return (
    <section aria-label="Your forms" className="flex flex-col gap-2 rounded-lg border p-4">
      <h2 className="text-sm font-medium">Your forms</h2>
      {quebec ? (
        <p className="text-xs text-muted-foreground">
          Both of your returns, filled in with what Taxi knows: the CRA's T1 for residents of Quebec with the schedules and forms it uses, then Revenu
          Québec's TP-1 with its schedules, and a worksheet that shows how each amount was worked out. Add your social insurance number, address and the
          other answers on the first pages by hand. Mail them in two parts, each signed: the federal return to the CRA, the TP-1 to Revenu Québec. Or copy
          the amounts into tax software certified for both. Revenu Québec's forms can be printed in French; the CRA's forms and the worksheet stay in
          English.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The CRA's T1, the schedules and forms your return uses and the provincial forms, filled in with what Taxi knows, and a worksheet that shows how
          each amount was worked out. Add your social insurance number, address and the other Step 1 answers by hand, sign the T1 and mail it; or copy the
          amounts into NETFILE-certified software.
        </p>
      )}
      {toAdd.length > 0 ? (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Forms to fill in yourself.</span> Your return needs these too, and Taxi doesn't print them:
            file each with your forms.
          </p>
          <ul aria-label="Forms to fill in yourself" className="list-disc pl-5">
            {toAdd.map(({ form, why }) => (
              <li key={form}>
                {form}: {why}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {quebec && ready ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span id={languageLabel}>Revenu Québec's forms in</span>
          <RadioGroup aria-labelledby={languageLabel} value={language} onValueChange={(value) => setLanguage(value as FormLanguage)} className="flex gap-3">
            {(["en", "fr"] as const).map((each) => (
              <Label key={each} className="flex cursor-pointer items-center gap-1.5 font-normal">
                <RadioGroupItem value={each} />
                <span lang={each}>{each === "en" ? "English" : "Français"}</span>
              </Label>
            ))}
          </RadioGroup>
        </div>
      ) : null}
      {ready ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void download()} disabled={state.status === "preparing"}>
              <FileDown aria-hidden="true" />
              Download the forms (PDF)
            </Button>
            <p role="status" className="text-xs text-muted-foreground">
              {state.status === "preparing" ? "Preparing your forms… The first time, Taxi downloads each official form, which can take a little while." : null}
            </p>
          </div>
          {state.status === "error" ? <RefusedBanner title="The forms weren't printed" error={state.error} unshown={[]} /> : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Finish the items under Before you file, above, to download them.</p>
      )}
    </section>
  );
}

interface Check {
  text: string;
  personId: string;
  step: Step | null;
  /** The question, when the check is an answer not given yet. */
  ask: string | null;
}

/**
 * Answers not given yet, put together by return and step when there are three or more: a list of every question of
 * a step reads as noise, and "Go to the step" leads to all of them at once.
 */
function groupUnanswered(checks: Check[], prefixOf: (personId: string) => string): Check[] {
  const groups = new Map<string, Check[]>();
  for (const check of checks) {
    if (check.ask === null || check.step === null) continue;
    const key = `${check.personId}:${check.step}`;
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  const out: Check[] = [];
  const done = new Set<string>();
  for (const check of checks) {
    const key = `${check.personId}:${check.step}`;
    const group = check.ask !== null ? groups.get(key) : undefined;
    if (!group || group.length < 3) {
      out.push(check);
      continue;
    }
    if (done.has(key)) continue;
    done.add(key);
    const asks = group.map((each) => each.ask!);
    out.push({
      text: `${prefixOf(check.personId)}${asks.length} questions on ${STEP_LABELS[check.step!]} not answered yet: ${asks.slice(0, 2).join(", ")} and ${asks.length - 2} more.`,
      personId: check.personId,
      step: check.step,
      ask: null,
    });
  }
  return out;
}
