import { printBlockers, type Slip, type TaxYear } from "#shared";
import { Dec } from "../../shared/engine/decimal.ts";
import { Evaluation } from "../../shared/engine/evaluate.ts";
import { fillForms } from "../../shared/engine/forms.ts";
import { documentName, type FormSpec, type RuleSet } from "../../shared/engine/rules.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { buildReturnPdf, type Worksheet, type WorksheetRow } from "./forms-pdf.ts";
import { ApiError, conflict, notFound } from "./http.ts";
import { openYear } from "./returns.ts";
import { engineInputOf, loadWorkspace, spouseResult } from "./workspace.ts";

// A return printed on the CRA's own forms, with a worksheet: built on request from what is stored, only once the
// return is finished (shared/print.ts). The CRA's print PDFs are downloaded from canada.ca the first time an
// organization prints and kept in D1 (form_files); a file whose SHA-256 isn't the one the layout was measured on is
// refused, so a form the CRA changed is never filled in the wrong places.

type Db = D1Database;

/** Where the CRA's forms come from. `checkHash` is off only in tests, which print on blank stand-in pages. */
export interface FormSource {
  fetch: (url: string) => Promise<Uint8Array>;
  checkHash: boolean;
}

const MAX_FORM_BYTES = 4 * 1024 * 1024;

export const craForms: FormSource = {
  checkHash: true,
  async fetch(url) {
    const response = await fetch(url, { headers: { Accept: "application/pdf" } });
    const type = response.headers.get("Content-Type") ?? "";
    if (!response.ok || !type.startsWith("application/pdf")) {
      throw new ApiError("unavailable", `The CRA's form couldn't be downloaded from canada.ca (HTTP ${response.status}). Try again later.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_FORM_BYTES) throw new ApiError("unavailable", "The CRA's form from canada.ca is larger than expected.");
    return bytes;
  },
};

export async function printReturn(db: Db, orgId: string, year: number, personId: string, source: FormSource, now: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; name: string }> {
  const { row, view } = await openYear(db, orgId, year);
  if (!view.adults.some((adult) => adult.personId === personId)) throw notFound("There is no such return in this year");
  const rules = rulesFor(year);
  if (!rules) throw notFound(`No tax rules for ${year}`);
  const workspace = await loadWorkspace(db, orgId, row.id);
  const evaluation = new Evaluation(rules, engineInputOf(view, workspace));
  const people = evaluation.result().people;
  const result = people.find((person) => person.personId === personId)!;
  const blockers = printBlockers(result, workspace.slips, spouseResult(view, people, personId));
  if (blockers.length > 0) {
    throw conflict(`The return isn't finished, so its forms can't be printed yet: ${blockers.map((blocker) => blocker.text).join(" ")}`);
  }
  const filled = fillForms(rules, evaluation, personId);
  const forms = [];
  for (const each of filled) forms.push({ filled: each, template: await formTemplate(db, orgId, each.form, source, now) });
  const person = view.people.find((each) => each.id === personId)!;
  const accepted = await db
    .prepare("SELECT hint, effect FROM hint_decisions WHERE org_id = ? AND tax_year_id = ? AND person_id = ? AND decision = 'accepted' ORDER BY decided_at")
    .bind(orgId, row.id, personId)
    .all<{ hint: string; effect: string | null }>();
  const worksheet = worksheetOf(rules, evaluation, view, {
    personId,
    name: person.name,
    slips: workspace.slips.filter((slip) => slip.personId === personId),
    answers: workspace.answers[personId] ?? {},
    hints: accepted.results,
    forms: filled.map((each) => each.form),
    now,
  });
  return { bytes: new Uint8Array(await buildReturnPdf(forms, worksheet)), name: `Taxi ${year} return - ${person.name}.pdf` };
}

/** A form's PDF: the copy kept for the organization, or downloaded from canada.ca and kept. */
async function formTemplate(db: Db, orgId: string, form: FormSpec, source: FormSource, now: number): Promise<Uint8Array> {
  const kept = await db.prepare("SELECT sha256, bytes FROM form_files WHERE org_id = ? AND url = ?").bind(orgId, form.url).first<{ sha256: string; bytes: ArrayBuffer | Uint8Array }>();
  if (kept && (!source.checkHash || kept.sha256 === form.sha256)) return kept.bytes instanceof Uint8Array ? kept.bytes : new Uint8Array(kept.bytes);
  const bytes = await source.fetch(form.url);
  const sha256 = await sha256Of(bytes);
  if (source.checkHash && sha256 !== form.sha256) {
    throw new ApiError(
      "unavailable",
      `The CRA has changed ${form.title} on canada.ca since this app measured it, so it isn't filled in. The app needs an update for the new form.`,
    );
  }
  await db
    .prepare(
      `INSERT INTO form_files (org_id, url, sha256, bytes, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, url) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes, fetched_at = excluded.fetched_at`,
    )
    .bind(orgId, form.url, sha256, bytes, now)
    .run();
  return bytes;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface WorksheetInput {
  personId: string;
  name: string;
  slips: Slip[];
  answers: Record<string, string | boolean>;
  hints: { hint: string; effect: string | null }[];
  forms: FormSpec[];
  now: number;
}

/** The worksheet: how to file, the result, what went in (slips, answers, applied hints), and every line worked out. */
function worksheetOf(rules: RuleSet, evaluation: Evaluation, view: TaxYear, input: WorksheetInput): Worksheet {
  const line = (id: string) => evaluation.line(input.personId, id).value;
  const refund = line("T1.48400");
  const owing = line("T1.48500");
  const prepared = new Date(input.now).toISOString().slice(0, 10);
  const formNames = input.forms.map((form) => form.title).join(" and ");

  const result: WorksheetRow[] = [
    owing && !owing.isZero() ? { text: "Balance owing (line 48500)", amount: money(owing) } : { text: "Refund (line 48400)", amount: money(refund ?? Dec.ZERO) },
    ...["T1.15000", "T1.23600", "T1.26000", "T1.42000", "T1.42800", "T1.43500", "T1.43700"].map((id) => ({
      text: `${rules.lines.get(id)!.label} (line ${id.split(".")[1]})`,
      amount: money(line(id) ?? Dec.ZERO),
    })),
  ];

  const slips: WorksheetRow[] = input.slips.map((slip) => {
    const type = rules.slips.get(slip.type);
    return {
      text: `${documentName(type, slip.type)} from ${slip.issuer}`,
      notes: Object.entries(slip.boxes).map(([box, amount]) => `${type?.receipt ? "" : `Box ${box} `}${type?.boxes[box] ?? ""}: ${money(Dec.from(amount))}`),
    };
  });

  const answers: WorksheetRow[] = [...rules.questions.values()]
    .filter((question) => question.id in input.answers)
    .map((question) => {
      const value = input.answers[question.id]!;
      return { text: question.ask, amount: typeof value === "boolean" ? (value ? "Yes" : "No") : question.type === "money" ? money(Dec.from(value)) : value };
    });

  const hints: WorksheetRow[] = input.hints.flatMap(({ hint, effect }) => {
    const spec = rules.hints.get(hint);
    return spec ? [{ text: spec.title, ...(effect ? { amount: `saves ${money(Dec.from(effect))}` } : {}) }] : [];
  });

  // Every line the return reads that has an amount, in the rules' order: the forms', the schedules' and worksheets'.
  const lines: WorksheetRow[] = evaluation
    .linesOf(input.personId)
    .map((id) => rules.lines.get(id)!)
    .flatMap((each) => {
      const value = line(each.id);
      if (value === null || value.isZero()) return [];
      return [{ text: `${each.id}  ${each.label}`, amount: money(value), notes: [`= ${each.text}`, ...(each.source ? [each.source] : [])] }];
    });

  return {
    title: `${input.name}: ${view.year} return worksheet`,
    intro: [
      `Prepared with Taxi on ${prepared}. Taxi doesn't file returns. Before this worksheet are the CRA's own forms (${formNames}) with the amounts filled in.`,
      "To file on paper: fill in Step 1 of the T1 by hand (your name, address, date of birth, social insurance number, marital status and the other questions), sign it, and mail it with the provincial form to your tax centre. Keep your slips and receipts; the CRA may ask for them.",
      "To file online: copy the amounts into NETFILE-certified tax software and file there.",
      "Schedules aren't filled in (for example Schedule 9 for donations and Schedule 11 for tuition). Their lines are worked out below; copy them onto the CRA's schedules if you file on paper.",
    ],
    sections: [
      { heading: "Result", rows: result },
      { heading: "Slips, receipts and notices", rows: slips.length > 0 ? slips : [{ text: "None." }] },
      { heading: "Answers", rows: answers },
      ...(hints.length > 0 ? [{ heading: "Hints applied", rows: hints }] : []),
      { heading: "How each line is worked out", rows: lines },
    ],
  };
}

function money(value: Dec): string {
  const rounded = value.roundTo(2, "HALF_UP");
  const [whole, fraction = ""] = rounded.abs().toString().split(".");
  return `${rounded.isNegative() ? "-" : ""}$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}
