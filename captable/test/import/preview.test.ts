import { describe, expect, it } from "vitest";
import { engine } from "../../src/app/shared/index.ts";
import { buildImportPreview, replayPlan } from "../../src/app/import/index.ts";
import { importWritePlanSchema } from "../../src/app/import/types.ts";
import { acmeExportFiles } from "./support/acme.ts";

const OPTIONS = { asOfDate: "2026-10-27", today: "2026-10-27" } as const;
const errors = (preview: ReturnType<typeof buildImportPreview>) => preview.problems.filter((item) => item.severity === "error");
const message = (preview: ReturnType<typeof buildImportPreview>, code: string) => preview.problems.find((item) => item.code === code)?.message ?? "";

describe("source-neutral spreadsheet import", () => {
  it("uses the single currency stated by Pulley instead of the fallback currency", () => {
    const files = acmeExportFiles((data) => {
      for (const row of [...data.raw.ShareClasses, ...data.raw.Convertibles]) row.Currency = "EUR";
    });
    const preview = buildImportPreview(files, { ...OPTIONS, fallbackCurrency: "NZD" });
    expect(errors(preview)).toEqual([]);
    expect(preview.plan?.referenceRows.find((row) => row.entity === "org_profile")).toMatchObject({ currency: "EUR" });
    expect(preview.plan?.referenceRows.filter((row) => row.entity === "stock_class"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ currency: "EUR" })]));
  });

  it("imports Pulley's real layout with styled cells, two plans, a 2:1 preferred class, early exercise, terminations, SAFEs, warrants and exact vesting", () => {
    const preview = buildImportPreview(acmeExportFiles(), OPTIONS);
    expect(errors(preview)).toEqual([]); expect(preview.canImport).toBe(true); expect(preview.plan?.sourceSystem).toBe("pulley");
    expect(preview.totals.app).toMatchObject({ fullyDiluted: "2890", issuedAndOutstanding: "1350" });
    expect(preview.totals.reconciliation.every((line) => line.matches)).toBe(true);
    expect(preview.problems).not.toContainEqual(expect.objectContaining({ code: "REPORT_TOTAL_MISMATCH" }));
    const { metrics } = replayPlan(preview.plan!);
    expect(Object.fromEntries(metrics.securities.map((item) => [item.displayId, { vested: item.vested.toCanonical(), vestedOutstanding: item.vestedOutstanding.toCanonical() }]))).toMatchObject({
      "OPT-14": { vested: "240", vestedOutstanding: "140" }, "OPT-EARLY": { vested: "50", vestedOutstanding: "0" }, "OPT-TERM": { vested: "60", vestedOutstanding: "60" }, "OPT-PREF": { vested: "25", vestedOutstanding: "25" },
    });
    expect(metrics.plans.map((item) => [item.name, item.equityOutstanding.toCanonical(), item.available.toCanonical()])).toEqual([["2024 Robotics Equity Plan", "640", "560"], ["2025 Preferred Equity Plan", "50", "150"]]);
    expect(preview.totals.reconciliation).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "company", metric: "issued shares", uploaded: "2180", app: "2180", matches: true }),
      expect.objectContaining({ scope: "company", metric: "outstanding shares", uploaded: "2040", app: "2040", matches: true }),
      expect.objectContaining({ scope: "holder", name: "Jordan Park", metric: "outstanding shares", uploaded: "630", app: "630", matches: true }),
      expect.objectContaining({ scope: "holder", name: "Nova Seed Fund", metric: "outstanding shares", uploaded: "220", app: "220", matches: true }),
      expect.objectContaining({ scope: "holder", name: "Sam Rivera", metric: "outstanding shares", uploaded: "60", app: "60", matches: true }),
    ]));
    expect(preview.draft.assumptions.join(" ")).toContain("inferred that the 2026-03-01 exercise produced CS-EX");
  });

  it("imports a former employee from Pulley's real layout without a termination-type column", () => {
    const preview = buildImportPreview(acmeExportFiles(), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const termination = preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "X_STAKEHOLDER_TERMINATION");
    expect(termination?.payload).toMatchObject({ termination_type: "voluntary", termination_date: "2026-06-30" });
    expect(preview.draft.assumptions).toContain("Sam Rivera: Pulley does not export a termination type, so this import uses voluntary as the conservative unspecified termination type.");
  });

  it("never guesses the export date from issue, exercise, cancellation, or expiration dates", () => {
    const preview = buildImportPreview(acmeExportFiles());
    expect(message(preview, "EXPORT_DATE_MISSING")).toContain("Choose the date");
    expect(preview.draft.asOfDate).toBeNull(); expect(preview.draft.suggestedAsOfDate).toBe("2026-10-27"); expect(preview.plan).toBeNull();
  });

  it("rejects an as-of date before a dated fact and after supplied today", () => {
    const before = buildImportPreview(acmeExportFiles(), { asOfDate: "2025-01-01", today: "2026-10-27" });
    expect(message(before, "DATE_AFTER_EXPORT")).toMatch(/after the as-of date/);
    const future = buildImportPreview(acmeExportFiles(), { asOfDate: "2026-10-28", today: "2026-10-27" });
    expect(message(future, "EXPORT_DATE_IN_FUTURE")).toContain("after today");
  });

  it("blocks changed, missing, and zero vesting events instead of dropping vesting", () => {
    for (const mutate of [
      (data: any) => { data.vestingEvents.find((row: any) => row["Security ID"] === "OPT-14")["Quantity Vested"] = "119"; },
      (data: any) => { data.vestingEvents = data.vestingEvents.filter((row: any) => row["Security ID"] !== "OPT-14"); },
      (data: any) => { data.vestingEvents.find((row: any) => row["Security ID"] === "OPT-14")["Quantity Vested"] = "0"; },
      (data: any) => { data.vestingSubjects.find((row: any) => row["Security ID"] === "OPT-14").Granted = "479"; },
    ]) expect(errors(buildImportPreview(acmeExportFiles(mutate), OPTIONS)).length).toBeGreaterThan(0);
  });

  it("records unvested cancellation separately and imports forfeited tranches with the termination", () => {
    const preview = buildImportPreview(acmeExportFiles(), OPTIONS); const plan = preview.plan!;
    const cancellation = plan.commands.flatMap((item) => item.transactions).find((item) => item.type === "TX_EQUITY_COMPENSATION_CANCELLATION" && item.sourceRef.includes("OPT-3"));
    expect(cancellation?.payload).toMatchObject({ quantity: "60", x_vesting_portion: "UNVESTED" });
    const termination = plan.commands.flatMap((item) => item.transactions).find((item) => item.type === "X_STAKEHOLDER_TERMINATION");
    expect(termination?.payload).toMatchObject({ termination_date: "2026-06-30", explicit_already_applied: true });
    expect(JSON.stringify(termination?.payload)).toContain("vesting_event_");
  });

  it("dates an undated unvested cancellation on the known termination date", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities.find((row) => row.CertificateId === "OPT-TERM")!.CancellationDate = ""; }), OPTIONS);
    const cancellation = preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "TX_EQUITY_COMPENSATION_CANCELLATION" && tx.sourceRef.includes("OPT-3"));
    expect(cancellation).toMatchObject({ effectiveDate: "2026-06-30", payload: { quantity: "60", x_vesting_portion: "UNVESTED" } });
    expect(message(preview, "CANCELLATION_DATE_ASSUMED")).toContain("termination date 2026-06-30");
  });

  it("dates an otherwise undated unvested cancellation on the as-of date instead of folding it into an opening balance", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      data.raw.Securities.find((row) => row.CertificateId === "OPT-TERM")!.CancellationDate = "";
      data.raw.StakeholderCompanies.find((row) => row.Id === "S-4")!.TerminationDate = "";
      data.stakeholders.find((row) => row["External ID"] === "S-4")!["Termination Date"] = "";
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const commands = preview.plan!.commands;
    expect(commands.flatMap((command) => command.transactions).find((tx) => tx.type === "TX_EQUITY_COMPENSATION_CANCELLATION" && tx.sourceRef.includes("OPT-3"))).toMatchObject({ effectiveDate: "2026-10-27", payload: { quantity: "60", x_vesting_portion: "UNVESTED" } });
    expect(commands.flatMap((command) => command.transactions).filter((tx) => tx.type === "X_MIGRATION_OPENING_BALANCE" && tx.sourceRef.includes("OPT-3"))).toEqual([]);
  });

  it("maps early exercise only from exported facts", () => {
    const preview = buildImportPreview(acmeExportFiles(), OPTIONS); const txs = preview.plan!.commands.flatMap((item) => item.transactions);
    const ordinary = txs.find((item) => item.type === "TX_EQUITY_COMPENSATION_EXERCISE" && item.sourceRef.includes("OPT-14"));
    const early = txs.find((item) => item.type === "TX_EQUITY_COMPENSATION_EXERCISE" && item.sourceRef.includes("OPT-EARLY"));
    expect(ordinary?.payload).not.toHaveProperty("x_early_exercise"); expect(early?.payload).toMatchObject({ x_early_exercise: true });
    const grant = txs.find((item) => item.type === "TX_EQUITY_COMPENSATION_ISSUANCE" && (item.payload as any).custom_id === "OPT-14");
    expect(grant?.payload).not.toHaveProperty("early_exercisable");
  });

  it("keeps vesting on an early-exercise share lot", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const lot = data.raw.Securities.find((row) => row.CertificateId === "CS-EARLY")!;
      lot.VestedAmount = { number: "25" }; lot.VestedOutstandingAmount = { number: "25" };
      data.vestingSubjects.push({ "Security ID": "CS-EARLY", Stakeholder: "Jordan Park", "Grant Date": { date: "2025-06-01" }, "Early Exercise": false, "Security Type": "SHARES", "Grant Type": "", "Vesting Start Date": { date: "2025-06-01" }, Granted: { number: "50" }, "Fully Diluted": { number: "50" } });
      data.vestingEvents.push({ "Security ID": "CS-EARLY", Stakeholder: "Jordan Park", "Security Type": "SHARES", "Vesting Date": { date: "2025-06-01" }, "Quantity Vested": { number: "25" }, "Forfeited/Canceled Prior to Vesting?": false });
      data.vestingEvents.push({ "Security ID": "CS-EARLY", Stakeholder: "Jordan Park", "Security Type": "SHARES", "Vesting Date": { date: "2027-06-01" }, "Quantity Vested": { number: "25" }, "Forfeited/Canceled Prior to Vesting?": false });
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    expect(replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "CS-EARLY")).toMatchObject({
      vested: expect.objectContaining({}), vestedOutstanding: expect.objectContaining({}),
    });
    const lot = replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "CS-EARLY")!;
    expect({ vested: lot.vested.toCanonical(), vestedOutstanding: lot.vestedOutstanding.toCanonical() }).toEqual({ vested: "25", vestedOutstanding: "25" });
  });

  it("blocks an exercise of unvested options when early exercise is false", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => { const row = data.exercises.find((item) => item["Option ID"] === "OPT-14")!; row["Options Unvested on Exercise Date"] = "1"; }), OPTIONS);
    expect(message(preview, "EARLY_EXERCISE_NOT_ALLOWED")).toContain("does not allow early exercise");
  });

  it("maps FMV, SAFE terms, conversion ratios, exercise deadlines, and exact instrument types", () => {
    const preview = buildImportPreview(acmeExportFiles(), OPTIONS); const txs = preview.plan!.commands.flatMap((item) => item.transactions);
    expect(txs.find((item) => (item.payload as any).custom_id === "OPT-14")?.payload).toHaveProperty("x_fmv.price_per_share.amount", "0.25");
    expect(txs.find((item) => (item.payload as any).custom_id === "SAFE-1")?.payload).toHaveProperty("x_safe_terms.valuation_cap.amount", "8000000");
    expect(txs.find((item) => item.type === "TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT")?.payload).toHaveProperty("new_ratio_conversion_mechanism.ratio.numerator", "2");
    expect(txs.find((item) => (item.payload as any).custom_id === "OPT-TERM")?.payload).toHaveProperty("termination_exercise_windows.0.period", 90);
    const replayed = replayPlan(preview.plan!);
    expect(engine.expiryCandidates(replayed.state, "2026-10-27").map((candidate) => replayed.state.securities.get(candidate.securityId)?.identity.displayId)).toContain("OPT-TERM");
  });

  it("takes an option's share class from its plan when Raw omits SecurityClassId", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => { for (const row of data.raw.Securities) if (row.EquityPlanType === "OPTIONS") row.SecurityClassId = ""; }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    expect(preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => (tx.payload as any).custom_id === "OPT-PREF")?.payload).toHaveProperty("stock_class_id");
  });

  it("uses an exact SHARES/OPTIONS/WARRANTS allowlist and blocks blank SAFE types", () => {
    for (const instrument of ["PHANTOM_STOCK", "RESTRICTED_STOCK_UNITS", "STOCK_APPRECIATION_RIGHTS", "STOCK_OPTIONS", "RSAS", ""]) {
      const preview = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities[0]!.EquityPlanType = instrument; }), OPTIONS);
      expect(message(preview, "INSTRUMENT_UNSUPPORTED")).toContain("Only shares, options, warrants, and SAFEs");
    }
    expect(message(buildImportPreview(acmeExportFiles((data) => { data.raw.Convertibles[0]!.Type = ""; }), OPTIONS), "INSTRUMENT_UNSUPPORTED")).toContain("blank convertible type");
  });

  it("blocks blank required numbers and disagreement between Raw and Exercised Options", () => {
    const blank = buildImportPreview(acmeExportFiles((data) => { data.exercises[0]!["Total Exercised"] = ""; }), OPTIONS);
    expect(message(blank, "NUMBER_MISSING")).toContain("Total Exercised");
    const mismatch = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities.find((row) => row.CertificateId === "OPT-14")!.ExercisedAmount = "101"; }), OPTIONS);
    expect(message(mismatch, "EXERCISED_AMOUNT_MISMATCH")).toContain("add up to 100");
    const cancellation = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities.find((row) => row.CertificateId === "OPT-TERM")!.CancelledAmount = "59"; }), OPTIONS);
    expect(message(cancellation, "SECURITY_QUANTITY_MISMATCH")).toContain("outstanding");
    const invalid = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities[0]!.OutstandingAmount = "-"; }), OPTIONS);
    expect(message(invalid, "DECIMAL_INVALID")).toContain("OutstandingAmount");
    const missingExercise = buildImportPreview(acmeExportFiles((data) => { data.exercises = data.exercises.filter((row) => row["Option ID"] !== "OPT-14"); }), OPTIONS);
    expect(message(missingExercise, "EXERCISED_AMOUNT_MISMATCH")).toContain("add up to 0");
    const staleDetail = buildImportPreview(acmeExportFiles((data) => { data.detailed["Common Stock"]![0]!["Shares Outstanding"] = "999"; }), OPTIONS);
    expect(message(staleDetail, "REPORT_SECURITY_MISMATCH")).toContain("Raw Cap Table");
  });

  it("defaults a blank exercised column on shares and blocks a transfer without recipient lineage", () => {
    const blank = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities.find((row) => row.CertificateId === "CS-1")!.ExercisedAmount = ""; }), OPTIONS);
    expect(errors(blank)).toEqual([]);

    const transfer = buildImportPreview(acmeExportFiles((data) => {
      const shares = data.raw.Securities.find((row) => row.CertificateId === "CS-1")!;
      shares.OutstandingAmount = { number: "960" }; shares.TransferredAmount = { number: "40" }; shares.TransferDate = { date: "2022-01-01" };
      data.detailed["Common Stock"]!.find((row) => row["Certificate ID"] === "CS-1")!["Shares Outstanding"] = { number: "960" };
    }), OPTIONS);
    expect(message(transfer, "TRANSFER_DETAILS_MISSING")).toContain("recipient");
  });

  it("uses a disclosed opening balance when exercise rows do not exactly match one certificate", () => {
    const oneDayLater = buildImportPreview(acmeExportFiles((data) => {
      data.raw.Securities.find((row) => row.CertificateId === "CS-EX")!.IssueDate = { date: "2026-03-02" };
      data.detailed["Common Stock"]!.find((row) => row["Certificate ID"] === "CS-EX")!["Issue Date"] = { date: "2026-03-02" };
    }), OPTIONS);
    expect(errors(oneDayLater)).toEqual([]);
    expect(oneDayLater.openingBalances).toContainEqual(expect.objectContaining({ displayId: "OPT-14", date: "2026-03-01" }));
    expect(oneDayLater.draft.assumptions.join(" ")).toContain("could not be linked");

    const consolidated = buildImportPreview(acmeExportFiles((data) => {
      const exercise = data.exercises.find((row) => row["Option ID"] === "OPT-14")!;
      exercise["Total Exercised"] = { number: "60" }; exercise["ISOs Exercised"] = { number: "60" };
      data.exercises.push({ ...exercise, "Total Exercised": { number: "40" }, "ISOs Exercised": { number: "40" } });
    }), OPTIONS);
    expect(errors(consolidated)).toEqual([]);
    expect(consolidated.openingBalances).toContainEqual(expect.objectContaining({ displayId: "OPT-14" }));

    const netExercise = buildImportPreview(acmeExportFiles((data) => {
      const lot = data.raw.Securities.find((row) => row.CertificateId === "CS-EX")!;
      lot.IssuedAmount = { number: "90" }; lot.OutstandingAmount = { number: "90" };
      const lotDetail = data.detailed["Common Stock"]!.find((row) => row["Certificate ID"] === "CS-EX")!;
      lotDetail["Shares Issued"] = { number: "90" }; lotDetail["Shares Outstanding"] = { number: "90" };
      Object.assign(data.raw.Company[0]!, { FullyDiluted: { number: "2890" }, Issued: { number: "2170" }, Outstanding: { number: "2020" } });
      data.raw.ShareClasses[0]!.OutstandingAmount = { number: "1140" };
      Object.assign(data.raw.EquityPlan[0]!, { AvailableAmount: { number: "570" }, OutstandingAmount: { number: "630" } });
      const holder = data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!;
      holder.FullyDiluted = { number: "670" }; holder.OutstandingAmount = { number: "620" };
      Object.assign(data.detailed.Summary![0]!, { "Issued and Outstanding": { number: "1340" }, "Fully Diluted": { number: "2890" } });
      Object.assign(data.detailed.Ownership!.find((row) => row["Stakeholder External ID"] === "S-2")!, { "Issued and Outstanding": { number: "140" }, "Fully Diluted": { number: "670" } });
    }), OPTIONS);
    expect(errors(netExercise)).toEqual([]);
    expect(netExercise.openingBalances).toContainEqual(expect.objectContaining({ displayId: "OPT-14", date: "2026-03-01" }));
    expect(replayPlan(netExercise.plan!).metrics.securities.find((item) => item.displayId === "CS-EX")?.outstanding.toCanonical()).toBe("90");
  });

  it("does not let an opening balance undo a later dated cancellation", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const exercise = data.exercises.find((row) => row["Option ID"] === "OPT-14")!;
      exercise["ISOs Exercised"] = { number: "60" }; exercise["NSOs Exercised"] = { number: "40" };
      const option = data.raw.Securities.find((row) => row.CertificateId === "OPT-14")!;
      option.CancelledAmount = { number: "30" }; option.OutstandingAmount = { number: "350" }; option.CancellationDate = { date: "2026-04-01" }; option.CancellationReason = "TERMINATION";
      data.detailed["2024 Robotics Equity Plan"]!.find((row) => row["Certificate ID"] === "OPT-14")!.Outstanding = { number: "350" };
      data.raw.EquityPlan[0]!.OutstandingAmount = { number: "610" }; data.raw.EquityPlan[0]!.AvailableAmount = { number: "590" };
      data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!.FullyDiluted = { number: "650" };
      data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!.OutstandingAmount = { number: "600" };
      data.detailed.Ownership!.find((row) => row["Stakeholder External ID"] === "S-2")!["Fully Diluted"] = { number: "650" };
      data.raw.Company[0]!.Outstanding = { number: "2010" };
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    expect(preview.openingBalances).toContainEqual(expect.objectContaining({ displayId: "OPT-14", date: "2026-03-01" }));
    const grant = replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "OPT-14")!;
    expect({ outstanding: grant.outstanding.toCanonical(), cancelled: grant.cancelled.toCanonical(), vestedOutstanding: grant.vestedOutstanding.toCanonical() }).toEqual({ outstanding: "350", cancelled: "30", vestedOutstanding: "140" });
  });

  it("keeps an unvested cancellation before an unmatched exercise out of the opening balance", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const exercise = data.exercises.find((row) => row["Option ID"] === "OPT-14")!;
      exercise["ISOs Exercised"] = { number: "60" }; exercise["NSOs Exercised"] = { number: "40" };
      const option = data.raw.Securities.find((row) => row.CertificateId === "OPT-14")!;
      option.CancelledAmount = { number: "30" }; option.UnvestedCancelledAmount = { number: "30" }; option.OutstandingAmount = { number: "350" };
      option.CancellationDate = { date: "2026-02-15" }; option.CancellationReason = "TERMINATION";
      data.detailed["2024 Robotics Equity Plan"]!.find((row) => row["Certificate ID"] === "OPT-14")!.Outstanding = { number: "350" };
      data.raw.EquityPlan[0]!.OutstandingAmount = { number: "610" }; data.raw.EquityPlan[0]!.AvailableAmount = { number: "590" };
      data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!.FullyDiluted = { number: "650" };
      data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!.OutstandingAmount = { number: "600" };
      data.detailed.Ownership!.find((row) => row["Stakeholder External ID"] === "S-2")!["Fully Diluted"] = { number: "650" };
      data.raw.Company[0]!.Outstanding = { number: "2010" };
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    expect(preview.openingBalances).toContainEqual(expect.objectContaining({ displayId: "OPT-14", date: "2024-02-01" }));
    const grant = replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "OPT-14")!;
    expect({ outstanding: grant.outstanding.toCanonical(), cancelled: grant.cancelled.toCanonical(), vestedOutstanding: grant.vestedOutstanding.toCanonical() }).toEqual({ outstanding: "350", cancelled: "30", vestedOutstanding: "140" });
  });

  it("refuses a dated cancellation when no issuance date can establish the security first", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      data.raw.Securities.find((row) => row.CertificateId === "OPT-TERM")!.IssueDate = "";
      data.vestingSubjects.find((row) => row["Security ID"] === "OPT-TERM")!["Grant Date"] = "";
      data.detailed["2024 Robotics Equity Plan"]!.find((row) => row["Certificate ID"] === "OPT-TERM")!["Grant Date"] = "";
    }), OPTIONS);
    expect(message(preview, "CANCELLATION_ISSUANCE_DATE_MISSING")).toContain("dated cancellation");
    expect(preview.problems.map((item) => item.message).join(" ")).not.toContain("ledger consistency problem");
  });

  it("uses namespaced safe refs, payload versions, certificate vocabulary, and deterministic row-order-independent ids", () => {
    const first = buildImportPreview(acmeExportFiles(), OPTIONS); const same = buildImportPreview(acmeExportFiles(), OPTIONS);
    expect(first.plan).toEqual(same.plan);
    expect(first.plan!.sourceIds.every((item) => /^[A-Za-z0-9_-]+$/.test(item.sourceId))).toBe(true);
    expect(first.plan!.commands.flatMap((item) => item.transactions).every((item) => item.payloadVersion === 1 && /^[A-Za-z0-9_-]+$/.test(item.sourceRef))).toBe(true);
    expect(first.plan!.referenceRows.filter((row) => row.entity === "certificate").every((row) => ["ISSUED", "CANCELLED", "VOID"].includes(row.status))).toBe(true);
    const reordered = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities.reverse(); data.vestingEvents.reverse(); for (const rows of Object.values(data.detailed)) rows.reverse(); }), OPTIONS);
    expect(reordered.plan!.commands.map((item) => item.id)).toEqual(first.plan!.commands.map((item) => item.id));
  });

  it("keeps punctuation-distinct Pulley IDs and identical same-day exercises collision-free", () => {
    const ids = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities[0]!.Id = "a.b"; data.raw.Securities[1]!.Id = "a_b"; }), OPTIONS);
    expect(errors(ids)).toEqual([]);
    expect(new Set(ids.draft.securities.slice(0, 2).map((item) => item.sourceId)).size).toBe(2);

    const exercises = buildImportPreview(acmeExportFiles((data) => {
      const exercise = data.exercises.find((row) => row["Option ID"] === "OPT-14")!;
      exercise["Total Exercised"] = { number: "50" }; exercise["ISOs Exercised"] = { number: "50" };
      data.exercises.push({ ...exercise });
    }), OPTIONS);
    expect(errors(exercises)).toEqual([]);
    expect(new Set(exercises.draft.exercises.filter((item) => item.optionDisplayId === "OPT-14").map((item) => item.sourceId)).size).toBe(2);
    expect(exercises.openingBalances).toContainEqual(expect.objectContaining({ displayId: "OPT-14" }));
  });

  it("keeps the same raw id collision-free across stakeholder, class, plan, and security namespaces", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      data.raw.StakeholderCompanies[0]!.Id = "1"; data.stakeholders[0]!["External ID"] = "1";
      data.raw.ShareClasses[0]!.Id = "1"; data.raw.EquityPlan[0]!.Id = "1"; data.raw.EquityPlan[0]!.SecurityClassId = "1";
      for (const row of data.raw.Securities) { if (row.SecurityClassId === "C-1") row.SecurityClassId = "1"; if (row.EquityPlanId === "P-1") row.EquityPlanId = "1"; }
      data.raw.Securities[0]!.Id = "1"; data.raw.Securities[0]!.StakeholderId = "1";
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const ids = preview.plan!.sourceIds.map((item) => `${item.entity}:${item.sourceId}`);
    expect(ids).toEqual(expect.arrayContaining(["stakeholder:stakeholder_1", "stock_class:class_1", "stock_plan:plan_1", "security:security_1"]));
    expect(new Set(ids).size).toBe(ids.length);
    const refs = preview.plan!.commands.flatMap((command) => command.transactions.map((tx) => tx.sourceRef));
    expect(refs).toEqual(expect.arrayContaining(["class_1", "plan_1", "security_1"]));
  });

  it("does not join two same-name stakeholders or leak an email", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      data.raw.StakeholderCompanies.push({ Id: "S-5", Name: "Jordan Park", Email: "", Relationship: "ADVISOR", StakeholderType: "INDIVIDUAL", FullyDiluted: "0", OutstandingAmount: "0" });
      data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!.Email = "";
      for (const row of data.stakeholders) delete row["External ID"];
      data.stakeholders.push({ Name: "Jordan Park", Email: "advisor@example.test", Type: "INDIVIDUAL", Relationship: "ADVISOR" });
    }), OPTIONS);
    expect(message(preview, "STAKEHOLDER_NAME_AMBIGUOUS")).toContain("More than one stakeholder");
    expect(preview.draft.stakeholders.filter((item) => item.name === "Jordan Park").every((item) => item.email === null)).toBe(true);
  });

  it("gives a plain-language error for an exercised grant without a grant date", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => { data.raw.Securities.find((row) => row.CertificateId === "OPT-14")!.IssueDate = ""; data.vestingSubjects.find((row) => row["Security ID"] === "OPT-14")!["Grant Date"] = ""; data.detailed["2024 Robotics Equity Plan"]!.find((row) => row["Certificate ID"] === "OPT-14")!["Grant Date"] = ""; }), OPTIONS);
    expect(message(preview, "GRANT_DATE_REQUIRED_FOR_EXERCISE")).toBe("Grant OPT-14 needs a valid grant date before its exercise can be imported.");
    expect(preview.problems.map((item) => item.message).join(" ")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("maps dated cancellations for shares, options, warrants and converted SAFEs", () => {
    const preview = buildImportPreview(acmeExportFiles(), OPTIONS); const types = preview.plan!.commands.flatMap((item) => item.transactions.map((tx) => tx.type));
    expect(types).toEqual(expect.arrayContaining(["TX_STOCK_CANCELLATION", "TX_EQUITY_COMPENSATION_CANCELLATION", "TX_WARRANT_CANCELLATION", "TX_CONVERTIBLE_CANCELLATION"]));
    expect(replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "SAFE-CONV")?.status).toBe("CANCELLED");
    expect(preview.draft.assumptions).toEqual(expect.arrayContaining([expect.stringContaining("SAFE-CONV"), expect.stringContaining("Authorized share counts"), expect.stringContaining("plan pool sizes")]));
  });

  it("uses the assumed cancellation date on the certificate reference", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const shares = data.raw.Securities.find((row) => row.CertificateId === "CS-CAN")!; shares.CancellationDate = ""; shares.StakeholderId = "S-4";
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    expect(preview.plan!.referenceRows.find((row) => row.entity === "certificate" && row.certificateNumber === "CS-CAN")).toMatchObject({ status: "CANCELLED", cancelledDate: "2026-06-30" });
  });

  it("uses the engine's return-to-pool defaults and keeps repurchased vested plan shares available", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const shares = data.raw.Securities.find((row) => row.CertificateId === "CS-EX")!;
      shares.OutstandingAmount = { number: "60" }; shares.CancelledAmount = { number: "40" }; shares.CancellationDate = { date: "2026-08-01" }; shares.CancellationReason = "Repurchased";
      data.detailed["Common Stock"]!.find((row) => row["Certificate ID"] === "CS-EX")!["Shares Outstanding"] = { number: "60" };
      data.raw.EquityPlan[0]!.OutstandingAmount = { number: "600" }; data.raw.EquityPlan[0]!.AvailableAmount = { number: "600" };
      data.raw.ShareClasses[0]!.OutstandingAmount = { number: "1110" };
      data.raw.Company[0]!.Outstanding = { number: "1960" };
      const holder = data.raw.StakeholderCompanies.find((row) => row.Id === "S-2")!; holder.FullyDiluted = { number: "640" }; holder.OutstandingAmount = { number: "590" };
      const detailed = data.detailed.Ownership!.find((row) => row["Stakeholder External ID"] === "S-2")!; detailed["Fully Diluted"] = { number: "640" }; detailed["Issued and Outstanding"] = { number: "110" };
      data.detailed.Summary![0]!["Issued and Outstanding"] = { number: "1310" };
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    expect(replayPlan(preview.plan!).metrics.plans.find((item) => item.name === "2024 Robotics Equity Plan")?.available.toCanonical()).toBe("600");
    expect(preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "X_STOCK_PLAN_TERMS")?.payload).toHaveProperty("return_rules.repurchased_vested_shares", "RETURN");
  });

  it("maps a dated unvested repurchase without changing opening balances or vested outstanding", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const shares = data.raw.Securities.find((row) => row.CertificateId === "CS-1")!;
      Object.assign(shares, {
        OutstandingAmount: { number: "600" }, RepurchasedAmount: { number: "400" }, RepurchaseDate: { date: "2022-01-01" },
        AmountPaidForRepurchase: { number: "0" }, VestedAmount: { number: "600" }, VestedOutstandingAmount: { number: "600" },
      });
      data.vestingSubjects.push({ "Security ID": "CS-1", Stakeholder: "Freya Lindqvist", "Grant Date": { date: "2020-01-02" }, "Early Exercise": false, "Security Type": "SHARES", "Grant Type": "", "Vesting Start Date": { date: "2020-01-02" }, Granted: { number: "1000" }, "Fully Diluted": { number: "1000" } });
      for (const date of ["2021-01-02", "2022-01-02", "2023-01-02", "2024-01-02", "2025-01-02"]) data.vestingEvents.push({ "Security ID": "CS-1", Stakeholder: "Freya Lindqvist", "Security Type": "SHARES", "Vesting Date": { date }, "Quantity Vested": { number: "200" }, "Forfeited/Canceled Prior to Vesting?": false });
      data.detailed["Common Stock"]!.find((row) => row["Certificate ID"] === "CS-1")!["Shares Outstanding"] = { number: "600" };
      Object.assign(data.raw.Company[0]!, { FullyDiluted: { number: "2490" }, Outstanding: { number: "1640" } });
      data.raw.ShareClasses[0]!.OutstandingAmount = { number: "750" };
      Object.assign(data.raw.StakeholderCompanies.find((row) => row.Id === "S-1")!, { FullyDiluted: { number: "600" }, OutstandingAmount: { number: "600" } });
      Object.assign(data.detailed.Ownership!.find((row) => row["Stakeholder External ID"] === "S-1")!, { "Issued and Outstanding": { number: "600" }, "Fully Diluted": { number: "600" } });
      Object.assign(data.detailed.Summary![0]!, { "Issued and Outstanding": { number: "950" }, "Fully Diluted": { number: "2490" } });
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const repurchase = preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "TX_STOCK_REPURCHASE");
    expect(repurchase).toMatchObject({ effectiveDate: "2022-01-01", payload: { quantity: "400", price: { amount: "0", currency: "USD" }, x_kind: "UNVESTED" } });
    expect(preview.plan!.commands.flatMap((command) => command.transactions).filter((tx) => tx.type === "X_MIGRATION_OPENING_BALANCE" && tx.sourceRef.includes("ST-1"))).toEqual([]);
    const lot = replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "CS-1")!;
    expect({ repurchased: lot.repurchased.toCanonical(), vestedOutstanding: lot.vestedOutstanding.toCanonical() }).toEqual({ repurchased: "400", vestedOutstanding: "600" });
  });

  it("keeps the exported consideration and uses the lot price when its extended amount rounds to cents", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const shares = data.raw.Securities.find((row) => row.CertificateId === "CS-1")!;
      Object.assign(shares, {
        Status: "REPURCHASED", IssuedAmount: { number: "123457" }, OutstandingAmount: { number: "0" },
        RepurchasedAmount: { number: "123457" }, RepurchaseDate: { date: "2026-01-02" },
        AmountPaidForRepurchase: { number: "12.35" }, PricePerShare: { number: "0.0001" },
      });
      Object.assign(data.detailed["Common Stock"]!.find((row) => row["Certificate ID"] === "CS-1")!, {
        "Shares Issued": { number: "123457" }, "Shares Outstanding": { number: "0" }, "Price Per Share": { number: "0.0001" },
      });
      Object.assign(data.raw.Company[0]!, { FullyDiluted: { number: "1890" }, Issued: { number: "124637" }, Outstanding: { number: "1040" } });
      Object.assign(data.raw.ShareClasses[0]!, { AuthorizedNumberOfShares: { number: "200000" }, OutstandingAmount: { number: "150" } });
      Object.assign(data.raw.StakeholderCompanies.find((row) => row.Id === "S-1")!, { FullyDiluted: { number: "0" }, OutstandingAmount: { number: "0" } });
      Object.assign(data.detailed.Ownership!.find((row) => row["Stakeholder External ID"] === "S-1")!, { "Issued and Outstanding": { number: "0" }, "Fully Diluted": { number: "0" } });
      Object.assign(data.detailed.Summary![0]!, { Authorized: { number: "205000" }, "Issued and Outstanding": { number: "350" }, "Available Shares": { number: "204650" }, "Fully Diluted": { number: "1890" } });
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const repurchase = preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "TX_STOCK_REPURCHASE");
    expect(repurchase).toMatchObject({ payload: { quantity: "123457", price: { amount: "0.0001", currency: "USD" }, x_consideration: { amount: "12.35", currency: "USD" } } });
    expect(preview.draft.assumptions.join(" ")).not.toContain("CS-1: the per-share repurchase price");
  });

  it("uses a 12-place quotient as the repurchase price and discloses the assumption", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const shares = data.raw.Securities.find((row) => row.CertificateId === "CS-1")!;
      Object.assign(shares, {
        OutstandingAmount: { number: "997" }, RepurchasedAmount: { number: "3" },
        RepurchaseDate: { date: "2026-01-02" }, AmountPaidForRepurchase: { number: "1" },
      });
      data.detailed["Common Stock"]!.find((row) => row["Certificate ID"] === "CS-1")!["Shares Outstanding"] = { number: "997" };
      Object.assign(data.raw.Company[0]!, { FullyDiluted: { number: "2887" }, Outstanding: { number: "2037" } });
      data.raw.ShareClasses[0]!.OutstandingAmount = { number: "1147" };
      Object.assign(data.raw.StakeholderCompanies.find((row) => row.Id === "S-1")!, { FullyDiluted: { number: "997" }, OutstandingAmount: { number: "997" } });
      Object.assign(data.detailed.Ownership!.find((row) => row["Stakeholder External ID"] === "S-1")!, { "Issued and Outstanding": { number: "997" }, "Fully Diluted": { number: "997" } });
      Object.assign(data.detailed.Summary![0]!, { "Issued and Outstanding": { number: "1347" }, "Fully Diluted": { number: "2887" } });
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const repurchase = preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "TX_STOCK_REPURCHASE");
    expect(repurchase).toMatchObject({ payload: { quantity: "3", price: { amount: "0.333333333333", currency: "USD" }, x_consideration: { amount: "1", currency: "USD" } } });
    expect(preview.draft.assumptions).toContainEqual(expect.stringMatching(/CS-1: the per-share repurchase price .*0\.333333333333.*12 fractional digits.*total consideration.*1 USD/i));
  });

  it("allows an untyped SAFE without inventing conversion timing or an uncapped term", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => { data.raw.Convertibles[0]!.Type = "SAFE"; delete data.raw.Convertibles[0]!.ValuationCap; }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const terms = preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => (tx.payload as any).custom_id === "SAFE-1")!.payload.x_safe_terms as Record<string, unknown>;
    expect(terms).toMatchObject({ conversion_timing: null, valuation_cap: null });
    expect(terms).not.toHaveProperty("uncapped");
    expect(preview.draft.assumptions.join(" ")).toContain("conversion timing");
  });

  it("keeps same-day equal vest rows within Vest Events and only deduplicates a matching milestone row", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      data.vestingEvents = data.vestingEvents.filter((row) => row["Security ID"] !== "OPT-PREF");
      for (const date of ["2026-01-15", "2026-01-15", "2027-01-15", "2027-01-15"]) data.vestingEvents.push({ "Security ID": "OPT-PREF", Stakeholder: "Jordan Park", "Vesting Date": { date }, "Quantity Vested": { number: "12.5" }, "Forfeited/Canceled Prior to Vesting?": false });
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const terms = preview.plan!.referenceRows.find((row) => row.entity === "vesting_terms" && row.name === "OPT-PREF vesting");
    expect(terms && terms.entity === "vesting_terms" && terms.definition.type === "EXPLICIT" ? terms.definition.events : []).toHaveLength(4);
  });

  it("uses total warrant purchase price and does not use ExercisableAmount as vested outstanding", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      const warrant = data.raw.Securities.find((row) => row.CertificateId === "WAR-1")!; warrant.PricePerShare = { number: "0.01" };
      const option = data.raw.Securities.find((row) => row.CertificateId === "OPT-14")!; delete option.VestedOutstandingAmount; option.ExercisableAmount = { number: "1" };
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const metrics = replayPlan(preview.plan!).metrics;
    expect(metrics.securities.find((item) => item.displayId === "WAR-1")?.capitalContribution.toCanonical()).toBe("0.2");
    expect(preview.draft.securities.find((item) => item.displayId === "OPT-14")?.vestedOutstanding).toBeNull();
  });

  it("records only sourced termination fields", () => {
    const preview = buildImportPreview(acmeExportFiles(), OPTIONS);
    const termination = preview.plan!.commands.flatMap((command) => command.transactions).find((tx) => tx.type === "X_STAKEHOLDER_TERMINATION")!;
    expect(termination.payload).toMatchObject({ termination_type: "voluntary", relationship_before: "ex_employee", relationship_after: "ex_employee" });
  });

  it("maps a partially converted SAFE with its date, remaining principal, and valuation cap", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      data.raw.Convertibles.push({ Id: "SAFE-3", CertificateId: "SAFE-PART", Type: "SAFE_POST_MONEY", IssueDate: { date: "2024-05-01" }, Principal: { number: "1000" }, PrincipalIssued: { number: "1000" }, PrincipalOutstanding: { number: "400" }, Status: "CONVERTED", StakeholderCompanyId: "S-3", ValuationCap: { number: "9000000" }, ConvertedDate: { date: "2026-05-01" }, Currency: "USD" });
      data.detailed.Convertibles!.push({ "Convertible ID": "SAFE-PART", Stakeholder: "Nova Seed Fund", "Grant Date": { date: "2024-05-01" }, "Principal Issued": { number: "1000" }, "Principal Outstanding": { number: "400" } });
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
    const txs = preview.plan!.commands.flatMap((command) => command.transactions);
    expect(txs.find((tx) => (tx.payload as any).custom_id === "SAFE-PART")?.payload).toHaveProperty("x_safe_terms.valuation_cap.amount", "9000000");
    expect(txs.find((tx) => tx.type === "TX_CONVERTIBLE_CANCELLATION" && tx.sourceRef.includes("SAFE-3"))).toMatchObject({ effectiveDate: "2026-05-01", payload: { amount: { amount: "600", currency: "USD" } } });
    expect(replayPlan(preview.plan!).metrics.securities.find((item) => item.displayId === "SAFE-PART")?.outstanding.toCanonical()).toBe("400");
  });

  it("deduplicates an achieved milestone and ignores an undated pending milestone", () => {
    const preview = buildImportPreview(acmeExportFiles((data) => {
      data.vestingEvents[0]!.Milestone = "Prototype";
      data.milestones.push({ "Security ID": "OPT-14", Stakeholder: "Jordan Park", Milestone: "Prototype", Date: data.vestingEvents[0]!["Vesting Date"]!, Quantity: data.vestingEvents[0]!["Quantity Vested"]!, Status: "COMPLETED" });
      data.milestones.push({ "Security ID": "OPT-14", Stakeholder: "Jordan Park", Milestone: "Launch", Date: "", Quantity: "1", Status: "PENDING" });
    }), OPTIONS);
    expect(errors(preview)).toEqual([]);
  });

  it("detects mutations of each uploaded reconciliation scope", () => {
    const mutations: Array<(data: any) => void> = [
      (d) => { d.raw.Company[0].FullyDiluted = "2891"; }, (d) => { d.raw.Company[0].Outstanding = "1351"; }, (d) => { d.raw.Company[0].Issued = "1401"; },
      (d) => { d.raw.ShareClasses[0].OutstandingAmount = "1151"; }, (d) => { d.raw.EquityPlan[0].AvailableAmount = "561"; }, (d) => { d.raw.EquityPlan[0].OutstandingAmount = "641"; },
      (d) => { d.raw.StakeholderCompanies[0].FullyDiluted = "1001"; }, (d) => { d.raw.StakeholderCompanies[0].OutstandingAmount = "1001"; },
    ];
    for (const mutate of mutations) {
      const mismatch = message(buildImportPreview(acmeExportFiles(mutate), OPTIONS), "TOTAL_MISMATCH");
      expect(mismatch).not.toBe(""); expect(mismatch).not.toContain("Make sure all files use the same as-of date");
    }
    expect(message(buildImportPreview(acmeExportFiles((data) => { data.raw.Securities.find((row) => row.CertificateId === "OPT-14")!.VestedAmount = "241"; }), OPTIONS), "TOTAL_MISMATCH")).toContain("vested");
  });

  it("reports a mapping/schema cause and validates dates, decimals, and transaction codes at the write-plan boundary", () => {
    const missingName = buildImportPreview(acmeExportFiles((data) => { data.raw.Company[0]!.Name = ""; }), OPTIONS);
    expect(missingName.problems).toContainEqual(expect.objectContaining({ code: "COMPANY_NAME_MISSING", message: expect.stringContaining("Company") }));
    expect(missingName.problems).not.toContainEqual(expect.objectContaining({ code: "IMPORT_MAPPING_FAILED" }));

    const plan = buildImportPreview(acmeExportFiles(), OPTIONS).plan!;
    const badDate = structuredClone(plan); badDate.asOfDate = "not-a-date";
    expect(importWritePlanSchema.safeParse(badDate).success).toBe(false);
    const badDecimal = structuredClone(plan); badDecimal.commands[0]!.transactions[0]!.quantity = "1.230";
    expect(importWritePlanSchema.safeParse(badDecimal).success).toBe(false);
    const badType = structuredClone(plan); badType.commands[0]!.transactions[0]!.type = "TX_NOT_REAL" as any;
    expect(importWritePlanSchema.safeParse(badType).success).toBe(false);
  });
});
