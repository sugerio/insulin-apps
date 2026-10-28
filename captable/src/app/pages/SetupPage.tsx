import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "#shared";
import { apiRequest, newIdempotencyKey } from "../api/request.ts";
import { useAuth, useMe } from "../auth/AuthProvider.tsx";
import { canSetUpCompany } from "../auth/access.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { DateField, SelectField, TextField } from "../components/Form.tsx";
import { ChoiceCard, ImportWizard, TemplateDownloadButton } from "../components/ImportWizard.tsx";
import { PageHead } from "../components/Page.tsx";
import { describeError } from "../lib/errors.ts";
import type { ImportSource } from "../lib/imports.ts";
import { FISCAL_YEAR_ENDS, JURISDICTIONS, timezones } from "../lib/org.ts";
import { useDocumentTitle } from "../lib/useDocumentTitle.ts";

// First run (one company per app): until the company exists, owners and admins choose how to start and everyone else
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
      <div className="center-page">
        <div className="card setup-card">
          <BrandMark size={40} />
          <h1>Cap Table isn't set up yet</h1>
          <p>An owner or admin of this app sets up the company the first time they open it. Ask one of them to open Cap Table from the Insulin console; then come back here.</p>
          <p className="setup-learn">Meanwhile, the docs explain what Cap Table does and the basics of equity: <Link to="/docs">Learn about cap tables</Link>.</p>
        </div>
      </div>
    );
  }
  if (start === "empty") return <SetupForm />;
  if (importing) return <SetupImport source={STARTS[start]} onImported={() => setImported(true)} />;
  return <SetupChoices />;
}

function SetupChoices() {
  return (
    <div className="center-page">
      <div className="card setup-card setup-choices">
        <BrandMark size={40} />
        <h1>Set up your company</h1>
        <p>Cap Table keeps one company's cap table. Choose how to start.</p>
        <ul className="choice-list" aria-label="Ways to set up the company">
          <ChoiceCard level={2} title="Start with an empty company" actions={<Link className="btn btn-primary" to="/setup?start=empty">Start with an empty company</Link>}>
            Enter the company's details now. You can import its cap table afterwards, while it is still empty.
          </ChoiceCard>
          <ChoiceCard level={2} title="Import from Pulley" actions={<Link className="btn btn-primary" to="/setup?start=pulley">Import from Pulley</Link>}>
            Upload Pulley's standard Excel exports, review what will be imported and fix any problems, then import.
          </ChoiceCard>
          <ChoiceCard
            level={2}
            title="Import from a spreadsheet"
            actions={<><Link className="btn btn-primary" to="/setup?start=spreadsheet">Import from a spreadsheet</Link><TemplateDownloadButton /></>}
          >
            Fill in the Cap Table spreadsheet template with your stakeholders, share classes, equity plans and holdings, then upload it.
          </ChoiceCard>
        </ul>
        <p className="setup-learn">
          New to cap tables, or not sure which way to start? <Link to="/docs">Learn about cap tables</Link>: what Cap Table does, how the import works, and the basics of equity.
        </p>
      </div>
    </div>
  );
}

/** The import wizard as the first run's page: the app's bar on top, no workspace yet. */
function SetupImport({ source, onImported }: { source: ImportSource; onImported: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="setup-import">
      <header className="setup-import-head">
        <BrandMark />
        <strong>Cap Table</strong>
        <span className="muted">Set up your company</span>
      </header>
      <main className="main" id="main" tabIndex={-1}>
        <section className="page">
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
      setProblem(describeError(error, { conflict: "The company is already set up. Reload the app to open it." }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-page">
      <form className="card setup-card" aria-label="Set up the company" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Link className="setup-back" to="/setup">← All ways to start</Link>
        <BrandMark size={40} />
        <h1>Set up your company</h1>
        <p>Cap Table keeps one company's cap table. Tell it which company; you can change all of this later in the company settings.</p>
        <fieldset className="form" disabled={busy}>
          <TextField label="Company name" required value={values.displayName} onChange={(value) => set("displayName", value)} placeholder="e.g. Acme Robotics" error={errors.displayName} />
          <TextField label="Legal name" value={values.legalName} onChange={(value) => set("legalName", value)} placeholder="e.g. Acme Robotics, Inc." hint="Defaults to the company name." error={errors.legalName} />
          <div className="form-grid">
            <SelectField label="State of incorporation" value={values.jurisdiction} onChange={(value) => set("jurisdiction", value)} options={JURISDICTIONS} />
            <DateField label="Incorporation date" value={values.incorporationDate} onChange={(value) => set("incorporationDate", value)} error={errors.incorporationDate} />
            <SelectField label="Time zone" required value={values.timezone} onChange={(value) => set("timezone", value)} options={timezones(values.timezone).map((zone) => [zone, zone] as const)}
              hint="Decides the company's “today” for vesting and deadlines." error={errors.timezone} />
            <SelectField label="Fiscal year end" value={values.fiscalYearEnd} onChange={(value) => set("fiscalYearEnd", value)} options={FISCAL_YEAR_ENDS} />
          </div>
        </fieldset>
        {problem ? <p className="err-inline" role="alert">{problem}</p> : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Setting up…" : "Set up company"}</button>
      </form>
    </div>
  );
}
