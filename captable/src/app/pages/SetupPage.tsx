import { useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { apiRequest, newIdempotencyKey } from "../api/request.ts";
import { useAuth, useMe } from "../auth/AuthProvider.tsx";
import { canSetUpCompany } from "../auth/access.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { DateField, SelectField, TextField } from "../components/Form.tsx";
import { ChoiceCard, ChoiceList, ImportWizard, TemplateDownloadButton } from "../components/ImportWizard.tsx";
import { PageHead } from "../components/Page.tsx";
import { describeError } from "../lib/errors.ts";
import type { ImportSource } from "../lib/imports.ts";
import { FISCAL_YEAR_ENDS, JURISDICTIONS, timezones } from "../lib/org.ts";
import { useDocumentTitle } from "../lib/useDocumentTitle.ts";

// First run (one company per Insulin organization): until the company exists, whoever records changes chooses how to start and everyone else
// sees a note to wait for them. Three ways in: an empty company (the form below; its details can be changed later
// under Company › Profile & Settings), or the import wizard with Pulley's exports or the Cap Table spreadsheet. The
// choice is in the address (?start=), so the browser's Back returns to the three choices.

interface SetupValues {
  displayName: string;
  legalName: string;
  jurisdiction: string;
  incorporationDate: string;
  timezone: string;
  fiscalYearEnd: string;
}

type SetupErrors = Partial<Record<keyof SetupValues, string>>;

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The company's internal key, derived from its name: lowercase letters, digits and hyphens. */
export function companyKey(name: string): string {
  const key = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return key.length >= 2 ? key : `company-${key || "1"}`;
}

export function validateSetup(values: SetupValues): SetupErrors {
  const errors: SetupErrors = {};
  if (!values.displayName.trim()) errors.displayName = "Enter the company name.";
  else if (values.displayName.trim().length > 100) errors.displayName = "At most 100 characters.";
  if (values.legalName.trim().length > 200) errors.legalName = "At most 200 characters.";
  if (values.incorporationDate && !/^\d{4}-\d{2}-\d{2}$/.test(values.incorporationDate)) errors.incorporationDate = "Enter a date.";
  if (!values.timezone) errors.timezone = "Choose the company's time zone.";
  return errors;
}

/** `POST /api/orgs` with what the form says; the legal name defaults to the company name. */
export function setupRequest(values: SetupValues): api.CreateOrgRequestInput {
  const displayName = values.displayName.trim();
  return {
    orgKey: companyKey(displayName),
    displayName,
    legalName: values.legalName.trim() || displayName,
    jurisdiction: values.jurisdiction,
    timezone: values.timezone,
    fiscalYearEnd: values.fiscalYearEnd,
    ...(values.incorporationDate ? { incorporationDate: values.incorporationDate } : {}),
  };
}

const STARTS = { pulley: "pulley", spreadsheet: "template" } as const satisfies Record<string, ImportSource>;

/** A first-run card in the middle of the page, outside the workspace: the brand, a title, then what the step needs. */
function SetupCard({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className="grid min-h-svh place-items-center bg-muted/40 p-6">
      <Card className={wide ? "w-full max-w-215" : "w-full max-w-155"}>
        <CardContent className="flex flex-col items-start gap-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:tracking-tight [&>p]:text-sm [&>p]:text-muted-foreground">
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

const TEXT_LINK = "font-medium text-foreground underline underline-offset-4";

export function SetupPage() {
  useDocumentTitle("Set up the company");
  const me = useMe();
  const [params] = useSearchParams();
  // Set once an import is committed: the app then switches to the new company, and the import's result stays on screen
  // until the admin leaves it (Back included).
  const [imported, setImported] = useState(false);
  const start = params.get("start");
  const importing = start === "pulley" || start === "spreadsheet";
  if (me.company !== null && !(imported && importing)) return <Navigate to="/" replace />;
  if (!canSetUpCompany(me)) {
    return (
      <SetupCard>
        <BrandMark size={40} />
        <h1>Cap Table isn't set up yet</h1>
        <p>An owner, admin or editor of your Insulin organization sets up the company the first time they open it. Ask one of them to open Cap Table; then come back here.</p>
        <p>Meanwhile, the docs explain what Cap Table does and the basics of equity: <Link className={TEXT_LINK} to="/docs">Learn about cap tables</Link>.</p>
      </SetupCard>
    );
  }
  if (start === "empty") return <SetupForm />;
  if (importing) return <SetupImport source={STARTS[start]} onImported={() => setImported(true)} />;
  return <SetupChoices />;
}

function SetupChoices() {
  return (
    <SetupCard wide>
      <BrandMark size={40} />
      <h1>Set up your company</h1>
      <p>Cap Table keeps one company's cap table. Choose how to start.</p>
      <ChoiceList label="Ways to set up the company">
        <ChoiceCard level={2} title="Start with an empty company" actions={<Button asChild><Link to="/setup?start=empty">Start with an empty company</Link></Button>}>
          Enter the company's details now. You can import its cap table afterwards, while it is still empty.
        </ChoiceCard>
        <ChoiceCard level={2} title="Import from Pulley" actions={<Button asChild><Link to="/setup?start=pulley">Import from Pulley</Link></Button>}>
          Upload Pulley's standard Excel exports, review what will be imported and fix any problems, then import.
        </ChoiceCard>
        <ChoiceCard
          level={2}
          title="Import from a spreadsheet"
          actions={<><Button asChild><Link to="/setup?start=spreadsheet">Import from a spreadsheet</Link></Button><TemplateDownloadButton /></>}
        >
          Fill in the Cap Table spreadsheet template with your stakeholders, share classes, equity plans and holdings, then upload it.
        </ChoiceCard>
      </ChoiceList>
      <p>
        New to cap tables, or not sure which way to start? <Link className={TEXT_LINK} to="/docs">Learn about cap tables</Link>: what Cap Table does, how the import works, and the basics of equity.
      </p>
    </SetupCard>
  );
}

/** The import wizard as the first run's page: the app's bar on top, no workspace yet. */
function SetupImport({ source, onImported }: { source: ImportSource; onImported: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-svh bg-background">
      <header className="flex h-13 items-center gap-2.5 border-b bg-background px-3 text-sm sm:px-5">
        <BrandMark />
        <strong className="font-semibold">Cap Table</strong>
        <span className="text-muted-foreground">Set up your company</span>
      </header>
      <main className="min-w-0 flex-1 outline-none" id="main" tabIndex={-1}>
        <section className="mx-auto flex w-full max-w-370 flex-col gap-5 px-5 pt-6 pb-14 lg:px-8">
          <PageHead
            title={source === "pulley" ? "Import from Pulley" : "Import from a spreadsheet"}
            sub={source === "pulley" ? "Set the company up from Pulley's standard exports." : "Set the company up from the Cap Table spreadsheet template."}
          />
          <ImportWizard initialSource={source} onExit={() => navigate("/setup")} exitLabel="All ways to start" onImported={onImported} />
        </section>
      </main>
    </div>
  );
}

function SetupForm() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState<SetupValues>(() => ({
    displayName: "", legalName: "", jurisdiction: "US-DE", incorporationDate: "", timezone: browserTimezone(), fiscalYearEnd: "12-31",
  }));
  const [errors, setErrors] = useState<SetupErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per intent: a retry of the same form resends it, so a lost answer can't create the company twice.
  const [key, setKey] = useState(newIdempotencyKey);
  const set = (field: keyof SetupValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setKey(newIdempotencyKey());
  };
  const submit = async () => {
    const found = validateSetup(values);
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await apiRequest(api.routes.createOrg, { body: setupRequest(values), idempotencyKey: key });
      await refresh();
      navigate("/", { replace: true });
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid min-h-svh place-items-center bg-muted/40 p-6">
      <form className="w-full max-w-155" aria-label="Set up the company" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Card>
          <CardContent className="flex flex-col items-start gap-3">
            <Link className="text-sm text-muted-foreground hover:text-foreground" to="/setup">← All ways to start</Link>
            <BrandMark size={40} />
            <h1 className="text-xl font-semibold tracking-tight">Set up your company</h1>
            <p className="text-sm text-muted-foreground">Cap Table keeps one company's cap table. Tell it which company; you can change all of this later in the company settings.</p>
            <fieldset className="flex w-full min-w-0 flex-col gap-4" disabled={busy}>
              <TextField label="Company name" required value={values.displayName} onChange={(value) => set("displayName", value)} placeholder="e.g. Acme Robotics" error={errors.displayName} />
              <TextField label="Legal name" value={values.legalName} onChange={(value) => set("legalName", value)} placeholder="e.g. Acme Robotics, Inc." hint="Defaults to the company name." error={errors.legalName} />
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField label="State of incorporation" value={values.jurisdiction} onChange={(value) => set("jurisdiction", value)} options={JURISDICTIONS} />
                <DateField label="Incorporation date" value={values.incorporationDate} onChange={(value) => set("incorporationDate", value)} error={errors.incorporationDate} />
                <SelectField label="Time zone" required value={values.timezone} onChange={(value) => set("timezone", value)} options={timezones(values.timezone).map((zone) => [zone, zone] as const)}
                  hint="Decides the company's “today” for vesting and deadlines." error={errors.timezone} />
                <SelectField label="Fiscal year end" value={values.fiscalYearEnd} onChange={(value) => set("fiscalYearEnd", value)} options={FISCAL_YEAR_ENDS} />
              </div>
            </fieldset>
            {problem ? <p className="text-sm font-medium text-destructive" role="alert">{problem}</p> : null}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? "Setting up…" : "Set up company"}</Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
