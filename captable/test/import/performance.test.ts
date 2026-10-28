import { expect, it } from "vitest";
import { buildCanonicalDraft } from "../../src/app/import/draft.ts";
import { mapDraftToLedger } from "../../src/app/import/map.ts";
import { orderCommands } from "../../src/app/import/order.ts";
import { reconcilePlan } from "../../src/app/import/reconcile.ts";
import { parseUploadedReports } from "../../src/app/import/reports.ts";
import { validateDraft } from "../../src/app/import/validate.ts";
import { acmeExportFiles } from "./support/acme.ts";

it("reports a dangling command dependency as an internal import error", () => {
  const ordered = orderCommands([{ id: "command", idempotencyKey: "key", type: "test", effectiveDate: "2026-01-01", securities: [], transactions: [], dependencies: ["missing"], sourceId: "security_test", rank: 0 }]);
  expect(ordered.problems).toContainEqual(expect.objectContaining({ code: "COMMAND_DEPENDENCY_MISSING", severity: "error" }));
});

it("builds a 2,000 grant by 48 vest-event preview within the worker-sized bound", () => {
  const count = 2_000; const quantity = count * 48;
  const files = acmeExportFiles((data) => {
    for (let index = 0; index < count; index += 1) {
      const id = `LOAD-${index}`;
      data.raw.Securities.push({ Id: id, CertificateId: id, Status: "OUTSTANDING", StakeholderId: "S-2", SecurityClassId: "C-1", EquityPlanId: "P-1", EquityPlanType: "OPTIONS", OptionGrantType: "NSO", IssueDate: { date: "2026-01-01" }, IssuedAmount: { number: "48" }, OutstandingAmount: { number: "48" }, VestedAmount: { number: "0" }, VestedOutstandingAmount: { number: "0" }, ExercisedAmount: { number: "0" }, CancelledAmount: { number: "0" }, UnvestedCancelledAmount: { number: "0" }, ExercisePrice: { number: "0.25" }, ExpirationDate: { date: "2036-01-01" }, HasEarlyExercise: false });
      data.detailed["2024 Robotics Equity Plan"]!.push({ "Certificate ID": id, "Stakeholder Name": "Jordan Park", "Grant Date": { date: "2026-01-01" }, Granted: { number: "48" }, Outstanding: { number: "48" }, Vested: { number: "0" } });
      data.vestingSubjects.push({ "Security ID": id, Stakeholder: "Jordan Park", "Grant Date": { date: "2026-01-01" }, "Early Exercise": false, "Security Type": "OPTIONS", "Grant Type": "NSO", "Vesting Start Date": { date: "2026-01-01" }, Granted: { number: "48" }, "Fully Diluted": { number: "48" } });
      for (let month = 0; month < 48; month += 1) {
        const date = new Date(Date.UTC(2027, month, 1)).toISOString().slice(0, 10);
        data.vestingEvents.push({ "Security ID": { shared: id }, "Vesting Date": { date }, "Quantity Vested": { number: "1" } });
      }
    }
    data.raw.Company[0]!.FullyDiluted = String(2890 + quantity);
    data.raw.Company[0]!.Issued = String(2180 + quantity); data.raw.Company[0]!.Outstanding = String(2040 + quantity);
    data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!.FullyDiluted = String(680 + quantity);
    data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!.OutstandingAmount = String(630 + quantity);
    const plan = data.raw.EquityPlan.find((row) => row.Id === "P-1")!;
    plan.AuthorizedAmount = String(1200 + quantity); plan.OutstandingAmount = String(640 + quantity);
  });
  const cpuStarted = process.cpuUsage();
  const timings: Record<string, number> = {}; let started = performance.now();
  const parsed = parseUploadedReports(files); timings.parse = performance.now() - started; started = performance.now();
  const draft = buildCanonicalDraft(parsed.reports); timings.draft = performance.now() - started; started = performance.now();
  const validation = validateDraft(draft, "2026-10-27", "2026-10-27", parsed.reports); timings.validate = performance.now() - started; started = performance.now();
  const mapped = mapDraftToLedger(draft, { asOfDate: "2026-10-27", orgId: "00000000-0000-7000-8000-000000000000", shareUnit: "1", currency: "USD", fileSha256: parsed.fileSha256 }); timings.map = performance.now() - started; started = performance.now();
  const reconciled = reconcilePlan(mapped.plan, draft); timings.reconcile = performance.now() - started;
  const elapsed = Object.values(timings).reduce((sum, value) => sum + value, 0);
  const cpu = process.cpuUsage(cpuStarted); const cpuMs = (cpu.user + cpu.system) / 1_000;
  console.info(`2,000 grants x 48 events preview: ${elapsed.toFixed(0)} ms wall, ${cpuMs.toFixed(0)} ms worker CPU`, timings);
  expect([...parsed.problems, ...validation, ...mapped.problems, ...reconciled.problems].filter((item) => item.severity === "error")).toEqual([]);
  expect(cpuMs).toBeLessThan(15_000);
}, 60_000);
