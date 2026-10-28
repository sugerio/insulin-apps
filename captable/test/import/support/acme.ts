import type { UploadedImportFile } from "../../../src/app/import/index.ts";
import { buildWorkbook, table, type TestSheet, type WorkbookCell } from "./workbook.ts";

type RecordRow = Record<string, WorkbookCell>;
interface AcmeRawData {
  Company: RecordRow[];
  Securities: RecordRow[];
  Convertibles: RecordRow[];
  StakeholderCompanies: RecordRow[];
  ShareClasses: RecordRow[];
  EquityPlan: RecordRow[];
}
export interface AcmeExportData { raw: AcmeRawData; detailed: Record<string, RecordRow[]>; stakeholders: RecordRow[]; vestingSubjects: RecordRow[]; vestingEvents: RecordRow[]; milestones: RecordRow[]; exercises: RecordRow[]; isoNso: RecordRow[] }

export function acmeExportFiles(change?: (data: AcmeExportData) => void): UploadedImportFile[] {
  const data = acmeData(); change?.(data);
  return [
    file("Pulley Raw Cap Table 2026-10-27.xlsx", rawSheets(data.raw)),
    file("Pulley Detailed Cap Table.xlsx", detailedSheets(data.detailed)),
    file("Pulley Stakeholders.xlsx", [{ name: "Stakeholders", rows: table(["", ...STAKEHOLDER_HEADERS], data.stakeholders, "Pulley Stakeholders") }]),
    file("Pulley Vesting Details.xlsx", [
      { name: "Equity Subject to Vesting", rows: table(["", ...VESTING_SUBJECT_HEADERS], data.vestingSubjects, "Pulley Equity Subject to Vesting") },
      { name: "Vest Events", rows: table(["", ...VEST_EVENT_HEADERS], data.vestingEvents, "Pulley Vest Events") },
      { name: "Milestone Vesting Schedule", rows: table(["", ...MILESTONE_HEADERS], data.milestones, "Pulley Milestones") },
    ]),
    file("Pulley Exercised Options.xlsx", [{ name: "Exercised Options", rows: table(["", ...EXERCISE_HEADERS], data.exercises, "Pulley Exercised Options") }]),
    file("Pulley ISO NSO Details.xlsx", [{ name: "ISO NSO split report", rows: table(["", ...ISO_NSO_HEADERS], data.isoNso, "Pulley ISO/NSO") }]),
  ];
}

function acmeData(): AcmeExportData {
  const n = (number: string): WorkbookCell => ({ number }); const d = (date: string): WorkbookCell => ({ date });
  return {
    raw: {
      Company: [{ Name: "Acme Robotics, Inc.", FullyDiluted: n("2890"), Issued: n("2180"), Outstanding: n("2040"), Voting: n("1350") }],
      Securities: [
        security("ST-1", "CS-1", "SHARES", "1000", "1000", "S-1", "C-1", { IssueDate: d("2020-01-02"), PricePerShare: n("0.001") }),
        security("ST-2", "PS-1", "SHARES", "200", "200", "S-3", "C-2", { IssueDate: d("2023-01-10"), PricePerShare: n("1") }),
        security("ST-3", "CS-EX", "SHARES", "100", "100", "S-2", "C-1", { IssueDate: d("2026-03-01"), PricePerShare: n("0.25"), EquityPlanId: "P-1" }),
        security("ST-4", "CS-EARLY", "SHARES", "50", "50", "S-2", "C-1", { IssueDate: d("2025-06-01"), PricePerShare: n("0.5"), EquityPlanId: "P-1" }),
        security("ST-CAN", "CS-CAN", "SHARES", "50", "0", "S-3", "C-1", { IssueDate: d("2024-01-01"), PricePerShare: n("1"), CancelledAmount: n("50"), CancellationDate: d("2025-01-01"), CancellationReason: "VOIDED" }),
        option("OPT-1", "OPT-14", "480", "380", "100", "0", "S-2", "C-1", "P-1", "ISO", "0.25", "240", "140", false, "2024-02-01", "2034-02-01"),
        option("OPT-2", "OPT-EARLY", "100", "50", "50", "0", "S-2", "C-1", "P-1", "NSO", "0.5", "50", "0", true, "2024-06-01", "2034-06-01"),
        option("OPT-3", "OPT-TERM", "120", "60", "0", "60", "S-4", "C-1", "P-1", "NSO", "0.5", "60", "60", false, "2024-01-15", "2034-01-15", { UnvestedCancelledAmount: n("60"), CancellationDate: d("2026-06-30"), CancellationReason: "TERMINATION", ExerciseDeadline: d("2026-09-28") }),
        option("OPT-4", "OPT-PREF", "50", "50", "0", "0", "S-2", "C-2", "P-2", "NSO", "1", "25", "25", false, "2025-01-15", "2035-01-15"),
        security("WAR-1", "WAR-1", "WARRANTS", "20", "20", "S-3", "C-2", { IssueDate: d("2024-02-01"), ExercisePrice: n("1.25"), PricePerShare: n("0.01"), ExpirationDate: d("2031-02-01") }),
        security("WAR-2", "WAR-CAN", "WARRANTS", "10", "0", "S-3", "C-1", { IssueDate: d("2024-02-01"), ExercisePrice: n("1.5"), PricePerShare: n("0.01"), ExpirationDate: d("2031-02-01"), CancelledAmount: n("10"), CancellationDate: d("2025-02-01"), CancellationReason: "EXPIRED" }),
      ],
      Convertibles: [
        { Id: "SAFE-1", CertificateId: "SAFE-1", Type: "SAFE_POST_MONEY", IssueDate: d("2024-03-01"), Principal: n("1000"), PrincipalIssued: n("1000"), PrincipalOutstanding: n("1000"), Status: "OUTSTANDING", StakeholderCompanyId: "S-3", ValuationCap: n("8000000"), Currency: "USD" },
        { Id: "SAFE-2", CertificateId: "SAFE-CONV", Type: "SAFE_PRE_MONEY", IssueDate: d("2023-03-01"), Principal: n("500"), PrincipalIssued: n("500"), PrincipalOutstanding: n("0"), Status: "CONVERTED", StakeholderCompanyId: "S-3", ValuationCap: n("5000000"), ConvertedDate: d("2025-04-01"), Currency: "USD" },
      ],
      StakeholderCompanies: [
        { Id: "S-1", Name: "Freya Lindqvist", Email: "freya@example.test", Relationship: "FOUNDER", StakeholderType: "INDIVIDUAL", FullyDiluted: n("1000"), OutstandingAmount: n("1000") },
        { Id: "S-2", Name: "Jordan Park", Email: "jordan@example.test", Relationship: "EMPLOYEE", StakeholderType: "INDIVIDUAL", FullyDiluted: n("680"), OutstandingAmount: n("630") },
        { Id: "S-3", Name: "Nova Seed Fund", Email: "ops@novaseed.example.com", Relationship: "INVESTOR", StakeholderType: "ORGANIZATION", FullyDiluted: n("440"), OutstandingAmount: n("220") },
        { Id: "S-4", Name: "Sam Rivera", Email: "sam@example.test", Relationship: "FORMER_EMPLOYEE", StakeholderType: "INDIVIDUAL", TerminationDate: d("2026-06-30"), FullyDiluted: n("60"), OutstandingAmount: n("60") },
      ],
      ShareClasses: [
        { Id: "C-1", Name: "Common Stock", ClassType: "COMMON", AuthorizedNumberOfShares: n("10000"), OutstandingAmount: n("1150"), ConversionRatio: n("1"), Currency: "USD" },
        { Id: "C-2", Name: "Series Seed", ClassType: "PREFERRED", AuthorizedNumberOfShares: n("5000"), OutstandingAmount: n("200"), ConversionRatio: n("2"), PricePerShare: n("1"), Currency: "USD" },
      ],
      EquityPlan: [
        { Id: "P-1", Name: "2024 Robotics Equity Plan", SecurityClassId: "C-1", AuthorizedAmount: n("1200"), AvailableAmount: n("560"), OutstandingAmount: n("640"), BoardApprovalDate: d("2024-01-15") },
        { Id: "P-2", Name: "2025 Preferred Equity Plan", SecurityClassId: "C-2", AuthorizedAmount: n("200"), AvailableAmount: n("150"), OutstandingAmount: n("50"), BoardApprovalDate: d("2025-01-01") },
      ],
    },
    detailed: {
      Summary: [{ Authorized: n("15000"), "Issued and Outstanding": n("1350"), "Available Shares": n("13650"), "Fully Diluted": n("2890") }],
      Ownership: [
        { "Stakeholder External ID": "S-1", Stakeholder: "Freya Lindqvist", "Stakeholder Type": "INDIVIDUAL", "Issued and Outstanding": n("1000"), "Fully Diluted": n("1000") },
        { "Stakeholder External ID": "S-2", Stakeholder: "Jordan Park", "Stakeholder Type": "INDIVIDUAL", "Issued and Outstanding": n("150"), "Fully Diluted": n("680") },
        { "Stakeholder External ID": "S-3", Stakeholder: "Nova Seed Fund", "Stakeholder Type": "ORGANIZATION", "Issued and Outstanding": n("200"), "Fully Diluted": n("440") },
        { "Stakeholder External ID": "S-4", Stakeholder: "Sam Rivera", "Stakeholder Type": "INDIVIDUAL", "Issued and Outstanding": n("0"), "Fully Diluted": n("60") },
      ],
      "Common Stock": [
        stockDetail("CS-1", "Freya Lindqvist", "2020-01-02", "1000", "1000", "0.001"), stockDetail("CS-EX", "Jordan Park", "2026-03-01", "100", "100", "0.25"), stockDetail("CS-EARLY", "Jordan Park", "2025-06-01", "50", "50", "0.5"), stockDetail("CS-CAN", "Nova Seed Fund", "2024-01-01", "50", "0", "1"),
      ],
      "Series Seed": [stockDetail("PS-1", "Nova Seed Fund", "2023-01-10", "200", "200", "1")],
      "2024 Robotics Equity Plan": [planDetail("OPT-14", "Jordan Park", "2024-02-01", "480", "380", "240"), planDetail("OPT-EARLY", "Jordan Park", "2024-06-01", "100", "50", "50"), planDetail("OPT-TERM", "Sam Rivera", "2024-01-15", "120", "60", "60")],
      "2025 Preferred Equity Plan": [planDetail("OPT-PREF", "Jordan Park", "2025-01-15", "50", "50", "25")],
      Warrants: [{ "Warrant ID": "WAR-1", Stakeholder: "Nova Seed Fund", Outstanding: n("20"), "Shares Issued": n("20"), "Exercise Price": n("1.25") }, { "Warrant ID": "WAR-CAN", Stakeholder: "Nova Seed Fund", Outstanding: n("0"), "Shares Issued": n("10"), "Exercise Price": n("1.5") }],
      Convertibles: [{ "Convertible ID": "SAFE-1", Stakeholder: "Nova Seed Fund", "Grant Date": d("2024-03-01"), "Principal Issued": n("1000"), "Principal Outstanding": n("1000") }, { "Convertible ID": "SAFE-CONV", Stakeholder: "Nova Seed Fund", "Grant Date": d("2023-03-01"), "Principal Issued": n("500"), "Principal Outstanding": n("0") }],
      "Voting Ownership": [{ "Stakeholder Name": "Freya Lindqvist", Votes: n("1000"), "Voting Ownership Percentage": "74.07%" }],
    },
    stakeholders: [
      { Name: "Freya Lindqvist", "External ID": "S-1", Email: "freya@example.test", Type: "INDIVIDUAL", Relationship: "FOUNDER", Country: "US" },
      { Name: "Jordan Park", "External ID": "S-2", Email: "jordan@example.test", Type: "INDIVIDUAL", Relationship: "EMPLOYEE", Country: "US" },
      { Name: "Nova Seed Fund", "External ID": "S-3", Email: "ops@novaseed.example.com", Type: "ORGANIZATION", Relationship: "INVESTOR", Country: "US" },
      { Name: "Sam Rivera", "External ID": "S-4", Email: "sam@example.test", Type: "INDIVIDUAL", Relationship: "FORMER_EMPLOYEE", "Termination Date": d("2026-06-30"), Country: "US" },
    ],
    vestingSubjects: [subject("OPT-14", "Jordan Park", "2024-02-01", "480", false, "ISO"), subject("OPT-EARLY", "Jordan Park", "2024-06-01", "100", true, "NSO"), subject("OPT-TERM", "Sam Rivera", "2024-01-15", "120", false, "NSO"), subject("OPT-PREF", "Jordan Park", "2025-01-15", "50", false, "NSO")],
    vestingEvents: [
      ...events("OPT-14", "Jordan Park", ["2025-02-01", "2026-02-01", "2027-02-01", "2028-02-01"], "120"),
      ...events("OPT-EARLY", "Jordan Park", ["2025-06-01", "2026-06-01", "2027-06-01", "2028-06-01"], "25"),
      ...events("OPT-TERM", "Sam Rivera", ["2025-01-15", "2026-01-15"], "30"),
      ...events("OPT-TERM", "Sam Rivera", ["2027-01-15", "2028-01-15"], "30", true, "2026-06-30"),
      ...events("OPT-PREF", "Jordan Park", ["2026-01-15", "2027-01-15"], "25"),
    ],
    milestones: [],
    exercises: [exercise("Jordan Park", "OPT-14", "0.25", "2026-03-01", "100", "0", "100", "0", "25", "ISO"), exercise("Jordan Park", "OPT-EARLY", "0.5", "2025-06-01", "0", "50", "50", "25", "25", "NSO")],
    isoNso: [split("Jordan Park", "OPT-14", "480", "0.25", "2024-02-01", "480", "0"), split("Jordan Park", "OPT-EARLY", "100", "0.5", "2024-06-01", "0", "100"), split("Sam Rivera", "OPT-TERM", "120", "0.5", "2024-01-15", "0", "120"), split("Jordan Park", "OPT-PREF", "50", "1", "2025-01-15", "0", "50")],
  };
}

function security(id: string, certificate: string, type: string, issued: string, outstanding: string, stakeholder: string, stockClass: string, extra: RecordRow = {}): RecordRow { return { Id: id, CertificateId: certificate, EquityPlanType: type, IssuedAmount: { number: issued }, OutstandingAmount: { number: outstanding }, ExercisedAmount: { number: "0" }, CancelledAmount: { number: "0" }, UnvestedCancelledAmount: { number: "0" }, Status: outstanding === "0" ? "CANCELLED" : "OUTSTANDING", StakeholderId: stakeholder, SecurityClassId: stockClass, ...extra } }
function option(id: string, certificate: string, issued: string, outstanding: string, exercised: string, cancelled: string, stakeholder: string, stockClass: string, plan: string, grantType: string, price: string, vested: string, vestedOutstanding: string, early: boolean, issue: string, expiry: string, extra: RecordRow = {}): RecordRow { return security(id, certificate, "OPTIONS", issued, outstanding, stakeholder, stockClass, { EquityPlanId: plan, OptionGrantType: grantType, IssueDate: { date: issue }, ExercisePrice: { number: price }, ExpirationDate: { date: expiry }, ExercisedAmount: { number: exercised }, CancelledAmount: { number: cancelled }, VestedAmount: { number: vested }, VestedOutstandingAmount: { number: vestedOutstanding }, HasEarlyExercise: early, ...extra }) }
function stockDetail(id: string, holder: string, issue: string, issued: string, outstanding: string, price: string): RecordRow { return { "Certificate ID": id, "Stakeholder Name": holder, "Issue Date": { date: issue }, "Shares Issued": { number: issued }, "Shares Outstanding": { number: outstanding }, "Price Per Share": { number: price } } }
function planDetail(id: string, holder: string, grant: string, issued: string, outstanding: string, vested: string): RecordRow { return { "Certificate ID": id, "Stakeholder Name": holder, "Grant Date": { date: grant }, Granted: { number: issued }, Outstanding: { number: outstanding }, Vested: { number: vested } } }
function subject(id: string, holder: string, grant: string, amount: string, early: boolean, type: string): RecordRow { return { "Security ID": id, Stakeholder: holder, "Grant Date": { date: grant }, "Early Exercise": early, "Security Type": "OPTIONS", "Grant Type": type, "Vesting Start Date": { date: grant }, Granted: { number: amount }, "Fully Diluted": { number: amount } } }
function events(id: string, holder: string, dates: string[], quantity: string, forfeited = false, termination = ""): RecordRow[] { return dates.map((date) => ({ "Security ID": id, Stakeholder: holder, "Security Type": "OPTIONS", "Vesting Date": { date }, "Quantity Vested": { number: quantity }, "Termination Date": termination ? { date: termination } : "", "Forfeited/Canceled Prior to Vesting?": forfeited })) }
function exercise(holder: string, id: string, price: string, date: string, iso: string, nso: string, total: string, unvested: string, vested: string, type: string): RecordRow { return { Name: holder, "Option ID": id, "Exercise Price": { number: price }, "Exercise Date": { date }, "Options Vested on Exercise Date": { number: vested }, "Options Unvested on Exercise Date": { number: unvested }, "ISOs Exercised": { number: iso }, "NSOs Exercised": { number: nso }, "Total Exercised": { number: total }, "Amount Paid": { number: String(Number(price) * Number(total)) }, Type: type } }
function split(holder: string, id: string, amount: string, fmv: string, date: string, iso: string, nso: string): RecordRow { return { Stakeholder: holder, "Grant ID": id, Notes: "", "Early Exercise": "FALSE", "Number of Options": { number: amount }, "FMV at Grant": { number: fmv }, "Grant Date": { date }, "ISOs - 2026": { number: iso }, "NSOs - 2026": { number: nso } } }

function rawSheets(raw: AcmeExportData["raw"]): TestSheet[] { return Object.entries(RAW_HEADERS).map(([name, headers]) => ({ name, rows: table(["", ...headers], raw[name as keyof AcmeRawData] ?? [], `Pulley ${name}`) })) }
function detailedSheets(detailed: AcmeExportData["detailed"]): TestSheet[] { return Object.entries(detailed).map(([name, records]) => ({ name, rows: table(["", ...DETAILED_HEADERS[name]!], records, `Pulley ${name}`) })) }
function file(name: string, sheets: TestSheet[]): UploadedImportFile { return { name, bytes: buildWorkbook(sheets) } }

const RAW_HEADERS: Record<string, string[]> = {
  Company: ["Name", "FullyDiluted", "Issued", "Outstanding", "Voting"],
  Securities: ["Id", "CertificateId", "Status", "StakeholderId", "SecurityClassId", "EquityPlanId", "EquityPlanType", "OptionGrantType", "IssueDate", "IssuedAmount", "OutstandingAmount", "VestedAmount", "VestedOutstandingAmount", "ExercisedAmount", "CancelledAmount", "RepurchasedAmount", "TransferredAmount", "UnvestedCancelledAmount", "ExercisePrice", "PricePerShare", "ExpirationDate", "ExerciseDeadline", "CancellationDate", "CancellationReason", "RepurchaseDate", "AmountPaidForRepurchase", "TransferDate", "HasEarlyExercise"],
  Convertibles: ["Id", "CertificateId", "Status", "StakeholderCompanyId", "Type", "IssueDate", "ConvertedDate", "Principal", "PrincipalIssued", "PrincipalOutstanding", "ValuationCap", "Uncapped", "Currency"],
  StakeholderCompanies: ["Id", "Name", "Email", "Relationship", "StakeholderType", "TerminationDate", "FullyDiluted", "OutstandingAmount"],
  ShareClasses: ["Id", "Name", "ClassType", "AuthorizedNumberOfShares", "OutstandingAmount", "ConversionRatio", "PricePerShare", "Currency"],
  EquityPlan: ["Id", "Name", "SecurityClassId", "AuthorizedAmount", "AvailableAmount", "OutstandingAmount", "BoardApprovalDate"],
};
const STAKEHOLDER_HEADERS = ["Name", "External ID", "Email", "Type", "Relationship", "Termination Date", "Country"];
const VESTING_SUBJECT_HEADERS = ["Security ID", "Stakeholder", "Grant Date", "Early Exercise", "Security Type", "Grant Type", "Vesting Start Date", "Granted", "Fully Diluted"];
const VEST_EVENT_HEADERS = ["Security ID", "Stakeholder", "Security Type", "Grant Type", "Grant Date", "Vesting Date", "Milestone", "Quantity Vested", "Termination Date", "Expiration Date", "Forfeited/Canceled Prior to Vesting?"];
const MILESTONE_HEADERS = ["Security ID", "Stakeholder", "Milestone", "Date", "Quantity", "Status"];
const EXERCISE_HEADERS = ["Name", "Option ID", "Exercise Price", "Exercise Date", "Options Vested on Exercise Date", "Options Unvested on Exercise Date", "ISOs Exercised", "NSOs Exercised", "Total Exercised", "Amount Paid", "Type"];
const ISO_NSO_HEADERS = ["Stakeholder", "Grant ID", "Notes", "Early Exercise", "Number of Options", "FMV at Grant", "Grant Date", "ISOs - 2026", "NSOs - 2026"];
const DETAILED_HEADERS: Record<string, string[]> = { Summary: ["Authorized", "Issued and Outstanding", "Available Shares", "Fully Diluted"], Ownership: ["Stakeholder External ID", "Stakeholder", "Stakeholder Type", "Issued and Outstanding", "Fully Diluted"], "Common Stock": ["Certificate ID", "Stakeholder Name", "Issue Date", "Shares Issued", "Shares Outstanding", "Price Per Share"], "Series Seed": ["Certificate ID", "Stakeholder Name", "Issue Date", "Shares Issued", "Shares Outstanding", "Price Per Share"], "2024 Robotics Equity Plan": ["Certificate ID", "Stakeholder Name", "Grant Date", "Granted", "Outstanding", "Vested"], "2025 Preferred Equity Plan": ["Certificate ID", "Stakeholder Name", "Grant Date", "Granted", "Outstanding", "Vested"], Warrants: ["Warrant ID", "Stakeholder", "Outstanding", "Shares Issued", "Exercise Price"], Convertibles: ["Convertible ID", "Stakeholder", "Grant Date", "Principal Issued", "Principal Outstanding"], "Voting Ownership": ["Stakeholder Name", "Votes", "Voting Ownership Percentage"] };
