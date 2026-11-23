import { PROVINCE_NAMES, filesJointly, formsToAdd, isAdult, printBlockers, returnsOf, type Province, type Slip, type TaxYear } from "#shared";
import { Dec } from "../../shared/engine/decimal.ts";
import { Evaluation } from "../../shared/engine/evaluate.ts";
import { fillForms, personalFacts } from "../../shared/engine/forms.ts";
import { documentName, type FormLanguage, type FormSpec, type RuleSet } from "../../shared/engine/rules.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { buildReturnPdf, type Worksheet, type WorksheetRow } from "./forms-pdf.ts";
import { hintsOf, stillApplied } from "./hints.ts";
import { ApiError, conflict, logError, notFound } from "./http.ts";
import { openYear } from "./returns.ts";
import { engineInputOf, loadWorkspace, printYear, spouseResult } from "./workspace.ts";

// A return printed on the official forms (the CRA's, and for a resident of Quebec Revenu Québec's TP-1 and schedules
// after them; or the IRS's Form 1040 and its schedules), with a worksheet: built on request from what is stored, only
// once the return is finished (shared/print.ts). The PDFs are downloaded from canada.ca, revenuquebec.ca or irs.gov the
// first time an organization prints and kept in D1 (form_files); a file whose SHA-256 isn't the one the layout was
// measured on is refused, so a form its publisher changed is never filled in the wrong places.

type Db = D1Database;

/** Where the forms come from. `checkHash` is off only in tests, which print on blank stand-in pages. */
export interface FormSource {
  fetch: (url: string) => Promise<Uint8Array>;
  checkHash: boolean;
}

const MAX_FORM_BYTES = 4 * 1024 * 1024;

/** Who publishes a form, for the messages: the CRA on canada.ca, Revenu Québec on revenuquebec.ca, the IRS on irs.gov. */
function publisherOf(url: string): { name: string; site: string } {
  const host = new URL(url).hostname;
  if (host.endsWith("revenuquebec.ca")) return { name: "Revenu Québec", site: "revenuquebec.ca" };
  if (host.endsWith("irs.gov")) return { name: "the IRS", site: "irs.gov" };
  return { name: "the CRA", site: "canada.ca" };
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// canada.ca never answers a request without a User-Agent and revenuquebec.ca refuses it (403); a Worker's fetch sends
// none of its own. canada.ca also drops a bot's User-Agent that has no contact URL (measured 2026-11-23: "Mozilla/5.0
// (compatible; Insulin Apps Taxi)" and "Taxi/1.0" are dropped, the same with "+https://…" added are answered), so keep
// the URL.
const USER_AGENT = "Mozilla/5.0 (compatible; InsulinAppsTaxi/1.0; +https://taxi.insulinapps.com)";
// One form's download, its body included. The sites answer in a second or two; a first print downloads its few forms
// one after another, and the whole print has to answer well within the 100 seconds Cloudflare waits for a response.
const DOWNLOAD_TIMEOUT_MS = 15_000;

/** The forms from their publishers' sites, through `send` (a test's stand-in for fetch), each within `timeoutMs`. */
export function officialForms(send: typeof fetch = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS): FormSource {
  return {
    checkHash: true,
    async fetch(url) {
      const { name, site } = publisherOf(url);
      const signal = AbortSignal.timeout(timeoutMs);
      const download = async () => {
        const response = await send(url, { headers: { Accept: "application/pdf", "User-Agent": USER_AGENT }, signal });
        const type = response.headers.get("Content-Type") ?? "";
        if (!response.ok || !type.startsWith("application/pdf")) {
          throw new ApiError("unavailable", `${capital(name)}'s form couldn't be downloaded from ${site} (HTTP ${response.status}). Try again later.`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_FORM_BYTES) throw new ApiError("unavailable", `${capital(name)}'s form from ${site} is larger than expected.`);
        return bytes;
      };
      try {
        // Settled by the timeout too, whether or not `send` and the body honour the signal.
        return await new Promise<Uint8Array>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          download().then(resolve, reject);
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (signal.aborted) throw new ApiError("unavailable", `${capital(name)}'s form couldn't be downloaded: ${site} didn't answer in time. Try again later.`);
        logError("form_download_failed", error, { site });
        throw new ApiError("unavailable", `${capital(name)}'s form couldn't be downloaded: ${site} couldn't be reached. Try again later.`);
      }
    },
  };
}

export const craForms = officialForms();

/**
 * A person's return on the forms, with the worksheet. In French (`language` fr), Revenu Québec's forms are printed on
 * their French versions; the CRA's forms and the worksheet stay in English.
 */
export async function printReturn(
  db: Db,
  orgId: string,
  year: number,
  personId: string,
  source: FormSource,
  now: number,
  language: FormLanguage = "en",
): Promise<{ bytes: Uint8Array<ArrayBuffer>; name: string }> {
  const { row, view } = await openYear(db, orgId, year);
  if (!view.adults.some((adult) => adult.personId === personId)) throw notFound("There is no such return in this year");
  // A joint return is the person preparing's: the spouse has none of their own to print.
  const members = returnsOf(view).find((each) => each.personId === personId)?.members;
  if (!members) throw notFound("This person is on a joint return: print it from the return of the person preparing");
  const rules = rulesFor(view.country, year);
  if (!rules) throw notFound(`No tax rules for ${year}`);
  if (rules.forms.size === 0) throw notFound("Printing this return on the official forms isn't available yet");
  const workspace = await loadWorkspace(db, orgId, row.id);
  const evaluation = new Evaluation(rules, engineInputOf(view, workspace));
  const evaluated = evaluation.result();
  const people = evaluated.people;
  const result = people.find((person) => person.personId === personId)!;
  // The dependants this return claims, with what is still unanswered about each, as Finish shows them.
  const selfId = view.people.find((each) => each.relationship === "self")?.id;
  const dependants = evaluation.input.family.dependants
    .filter((dependant) => members.includes(dependant.claimedBy ?? selfId ?? ""))
    .flatMap((dependant) => {
      const asked = evaluated.dependants.find((each) => each.dependantId === dependant.id);
      return asked ? [{ name: dependant.name, result: asked }] : [];
    });
  const blockers = printBlockers(printYear(rules, view.issues, workspace), result, spouseResult(view, people, personId), dependants);
  if (blockers.length > 0) {
    throw conflict(`The return isn't finished, so its forms can't be printed yet: ${blockers.map((blocker) => blocker.text).join(" ")}`);
  }
  // Step 1 names the spouse even when their return isn't prepared here: the other adult in the profile.
  const partner = view.people.find((each) => each.id !== personId && isAdult(each.relationship));
  const facts = personalFacts(evaluation.input, personId, {
    spouseName: partner?.name,
    spouseBirthDate: partner?.birthDate,
    provinceName: (code) => PROVINCE_NAMES[code as Province] ?? code,
    joint: filesJointly(view),
  });
  const filled = fillForms(rules, evaluation, personId, facts, language);
  const forms = [];
  for (const each of filled) forms.push({ filled: each, template: await formTemplate(db, orgId, each.form, source, now) });
  const person = view.people.find((each) => each.id === personId)!;
  const accepted = await db
    .prepare("SELECT person_id, hint, decision, effect, previous FROM hint_decisions WHERE org_id = ? AND tax_year_id = ? AND person_id = ? AND decision = 'accepted' ORDER BY decided_at")
    .bind(orgId, row.id, personId)
    .all<{ person_id: string; hint: string; decision: "accepted"; effect: string | null; previous: string }>();
  // Only the savings that still hold: one whose answers were changed since isn't applied any more.
  const applied = accepted.results.length > 0 ? stillApplied(accepted.results, hintsOf(view, workspace), workspace.answers) : [];
  const worksheet = worksheetOf(rules, evaluation, view, {
    personId,
    name: person.name,
    slips: workspace.slips.filter((slip) => slip.personId === personId),
    answers: workspace.answers[personId] ?? {},
    hints: applied.map(({ hint, effect }) => ({ hint, effect })),
    forms: filled.map((each) => each.form),
    left: filled.flatMap((each) => (each.left.length > 0 ? [{ form: each.form, names: each.left }] : [])),
    now,
  });
  return { bytes: new Uint8Array(await buildReturnPdf(forms, worksheet)), name: `Taxi ${year} return - ${person.name}.pdf` };
}

/** A form's PDF: the copy kept for the organization, or downloaded from its publisher's site and kept. */
async function formTemplate(db: Db, orgId: string, form: FormSpec, source: FormSource, now: number): Promise<Uint8Array> {
  const kept = await db.prepare("SELECT sha256, bytes FROM form_files WHERE org_id = ? AND url = ?").bind(orgId, form.url).first<{ sha256: string; bytes: ArrayBuffer | Uint8Array }>();
  if (kept && (!source.checkHash || kept.sha256 === form.sha256)) return kept.bytes instanceof Uint8Array ? kept.bytes : new Uint8Array(kept.bytes);
  const bytes = await source.fetch(form.url);
  const sha256 = await sha256Of(bytes);
  if (source.checkHash && sha256 !== form.sha256) {
    const { name, site } = publisherOf(form.url);
    throw new ApiError(
      "unavailable",
      `${capital(name)} has changed ${form.title} on ${site} since this app measured it, so it isn't filled in. The app needs an update for the new form.`,
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
  /** The dependants a form's table had no room for, by form. */
  left: { form: FormSpec; names: string[] }[];
  now: number;
}

/** The worksheet: how to file, the result, what went in (slips, answers, applied hints), and every line worked out. */
function worksheetOf(rules: RuleSet, evaluation: Evaluation, view: TaxYear, input: WorksheetInput): Worksheet {
  const line = (id: string) => evaluation.line(input.personId, id).value;
  const prepared = new Date(input.now).toISOString().slice(0, 10);
  const formNames = input.forms.map((form) => form.title).join("; ");
  // A table of dependants with no room for some: the instructions ask for them on a statement attached to the form.
  const statements: WorksheetRow[] = input.left.map(({ form, names }) => ({
    text: `A statement with your other ${form.id === "F2441" ? "qualifying persons" : "dependents"}, attached to ${form.title.split(",")[0]}`,
    notes: [`${form.title.split(",")[0]} has room for ${form.dependants!.columns}: list ${names.join(", ")} with the same details, as its instructions say`],
  }));
  const toAdd: WorksheetRow[] = [...statements, ...formsToAdd(rules, evaluation, input.personId).map(({ form, why }) => ({ text: form, notes: [why] }))];
  const otherForms = toAdd.length > 0 ? 'the forms under "Forms to fill in yourself", below, and any other form not listed above' : "any form not listed above";
  const { intro, result } =
    rules.country === "us"
      ? usWorksheet(rules, line, { prepared, formNames, otherForms, joint: filesJointly(view) })
      : canadaWorksheet(rules, evaluation, line, input.personId, { prepared, formNames, otherForms });
  const slips: WorksheetRow[] = input.slips.map((slip) => {
    const type = rules.slips.get(slip.type);
    return {
      text: `${documentName(type, slip.type)} from ${slip.issuer}`,
      notes: Object.entries(slip.boxes).map(([box, amount]) => `${type?.receipt ? "" : `Box ${box} `}${type?.boxes[box] ?? ""}: ${type?.counts.includes(box) ? amount : money(Dec.from(amount))}`),
    };
  });

  const answers: WorksheetRow[] = [...rules.questions.values()]
    .filter((question) => question.id in input.answers)
    .map((question) => {
      const value = input.answers[question.id]!;
      const shown =
        typeof value === "boolean"
          ? value
            ? "Yes"
            : "No"
          : question.type === "money"
            ? money(Dec.from(value))
            : question.type === "percent"
              ? `${value}%`
              : (question.optionLabels?.[value] ?? value);
      // A group's part is named with its group: "Self-employment or business income: Gross income".
      const parent = question.parent ? rules.questions.get(question.parent) : undefined;
      return { text: parent ? `${parent.ask}: ${question.ask}` : question.ask, amount: shown };
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
    intro,
    sections: [
      { heading: "Result", rows: result },
      ...(toAdd.length > 0 ? [{ heading: "Forms to fill in yourself", rows: toAdd }] : []),
      { heading: "Slips, receipts and notices", rows: slips.length > 0 ? slips : [{ text: "None." }] },
      { heading: "Answers", rows: answers },
      ...(hints.length > 0 ? [{ heading: "Hints applied", rows: hints }] : []),
      { heading: "How each line is worked out", rows: lines },
    ],
  };
}

interface WorksheetText {
  prepared: string;
  formNames: string;
  otherForms: string;
}

/** A Canadian return's worksheet text: how to file (a resident of Quebec files two returns), and the result. */
function canadaWorksheet(
  rules: RuleSet,
  evaluation: Evaluation,
  line: (id: string) => Dec | null,
  personId: string,
  { prepared, formNames, otherForms }: WorksheetText,
): { intro: string[]; result: WorksheetRow[] } {
  const refund = line("T1.48400");
  const owing = line("T1.48500");
  // A resident of Quebec files two returns, the federal one and Revenu Québec's TP-1, each with its own result.
  const quebec = evaluation.input.people.find((each) => each.id === personId)?.province === "QC";
  const quebecOwing = line("TP1.479");

  const result: WorksheetRow[] = [
    owing && !owing.isZero() ? { text: "Balance owing (line 48500)", amount: money(owing) } : { text: "Refund (line 48400)", amount: money(refund ?? Dec.ZERO) },
    ...["T1.15000", "T1.23600", "T1.26000", "T1.42000", "T1.42800", "T1.43500", "T1.43700"].map((id) => ({
      text: `${rules.lines.get(id)!.label} (line ${id.split(".")[1]})`,
      amount: money(line(id) ?? Dec.ZERO),
    })),
    ...(quebec
      ? [
          quebecOwing && !quebecOwing.isZero()
            ? { text: "Quebec balance due (TP-1 line 479)", amount: money(quebecOwing) }
            : { text: "Quebec refund (TP-1 line 478)", amount: money(line("TP1.478") ?? Dec.ZERO) },
          ...["TP1.199", "TP1.275", "TP1.299", "TP1.432", "TP1.450"].map((id) => ({
            text: `${rules.lines.get(id)!.label} (TP-1 line ${id.split(".")[1]})`,
            amount: money(line(id) ?? Dec.ZERO),
          })),
        ]
      : []),
  ];

  return {
    intro: quebec
      ? [
          `Prepared with Taxi on ${prepared}. Taxi doesn't file returns. As a resident of Quebec you file two returns, and both are here, filled in with what Taxi knows: first the federal return on the CRA's forms, then your Quebec return on Revenu Québec's TP-1 and its schedules: ${formNames}.`,
          "Filled in for you: in Step 1 of the T1, your name, date of birth, marital status and province, and your spouse's or partner's first name and net income; on pages 1 and 2 of the TP-1, your name and date of birth, whether you had a spouse, and your spouse's name, date of birth and net income; on both returns and on each schedule and form above, every row Taxi works out. A row left blank is one Taxi doesn't know or that doesn't apply to you.",
          `Still to do by hand before you file on paper: on both returns, your social insurance number, mailing address and your spouse's or partner's social insurance number; on the T1, your email address, language and the other Step 1 questions; on the TP-1, your sex, language of communication and the other questions on page 1; any blank row of a schedule that applies to you (such as each child's details on Schedule C); and ${otherForms}. Keep your slips and receipts; the CRA and Revenu Québec may ask for them.`,
          "Mail the two returns in two parts, each signed: the federal return (the T1 for residents of Quebec, with its schedules and forms) to the CRA, at your tax centre; the TP-1, with its schedules, to Revenu Québec.",
          "To file online: copy the amounts into tax software certified for NETFILE and for Revenu Québec's NetFile Québec, and file both returns there.",
          "Every line Taxi works out is listed below with how it was worked out.",
        ]
      : [
          `Prepared with Taxi on ${prepared}. Taxi doesn't file returns. Before this worksheet are the CRA's own forms, filled in with what Taxi knows: ${formNames}.`,
          "Filled in for you: in Step 1 of the T1, your name, date of birth, marital status and province of residence, and your spouse's or partner's first name and net income; on the T1 and on each schedule and form above, every row Taxi works out. A row left blank is one Taxi doesn't know or that doesn't apply to you.",
          `Still to do by hand before you file on paper: in Step 1 of the T1, your social insurance number, mailing address, email address and language, your spouse's or partner's social insurance number, and the other questions (Elections Canada, income exempt under the Indian Act, the organ donor registry); any blank row of a schedule that applies to you (such as each dependant's details, or each property's address); and ${otherForms} (such as Schedule 7 for RRSP contributions, Form T1135, or a provincial form such as ON428-A). Then sign the T1 and mail it with the other forms to your tax centre. Keep your slips and receipts; the CRA may ask for them.`,
          "To file online: copy the amounts into NETFILE-certified tax software and file there.",
          "Every line Taxi works out is listed below with how it was worked out.",
        ],
    result,
  };
}

/**
 * A US return's worksheet text: what Taxi filled in, what is left to fill in by hand, and how to file (by mail to the
 * IRS, at the address irs.gov gives for the state, or by e-file); and the result, from the rules' result lines.
 */
function usWorksheet(
  rules: RuleSet,
  line: (id: string) => Dec | null,
  { prepared, formNames, otherForms, joint }: WorksheetText & { joint: boolean },
): { intro: string[]; result: WorksheetRow[] } {
  const named = (id: string) => `${rules.lines.get(id)!.label} (line ${id.split(".")[1]})`;
  const owing = line("F1040.37");
  const result: WorksheetRow[] = [
    owing && !owing.isZero() ? { text: named("F1040.37"), amount: money(owing) } : { text: named("F1040.34"), amount: money(line("F1040.34") ?? Dec.ZERO) },
    ...["F1040.9", "F1040.11a", "F1040.12e", "F1040.15", "F1040.16", "F1040.24", "F1040.33"].map((id) => ({ text: named(id), amount: money(line(id) ?? Dec.ZERO) })),
  ];
  return {
    intro: [
      `Prepared with Taxi on ${prepared}. Taxi doesn't file returns. Before this worksheet are the IRS's own forms, filled in with what Taxi knows: ${formNames}.`,
      `Filled in for you: on Form 1040, ${joint ? "your names" : "your name"}, your filing status, each dependent's name and relationship with the boxes that apply, and every line Taxi works out; on each schedule and form above, the names on the return and every row Taxi works out. A row left blank is one Taxi doesn't know or that doesn't apply to you.`,
      `Still to do by hand before you file on paper: the social security numbers (${joint ? "yours, your spouse's" : "yours"} and each dependent's or child's) on Form 1040 and at the top of each schedule and form; your address; the questions Taxi doesn't ask (the presidential election campaign fund, digital assets, whether your main home was in the U.S., and "And in the U.S." for each dependent); your bank details if you want the refund deposited; on Form 2441, each care provider's name, address and identifying number (Part I); and ${otherForms}. Then sign and date Form 1040${joint ? " (both of you)" : ""}, and attach Copy B of each Form W-2. Keep your forms and records; the IRS may ask for them.`,
      "Mail the return to the IRS address for your state on irs.gov/WhereToFile: it is different when you send a payment with it.",
      "To file online: copy the amounts into IRS e-file software (irs.gov/efile) and file there.",
      "Every line Taxi works out is listed below with how it was worked out.",
    ],
    result,
  };
}

function money(value: Dec): string {
  const rounded = value.roundTo(2, "HALF_UP");
  const [whole, fraction = ""] = rounded.abs().toString().split(".");
  return `${rounded.isNegative() ? "-" : ""}$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}
