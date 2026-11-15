import { describe, expect, it } from "vitest";
import {
  commandEnvelopeSchema,
  dryRunEnvelopeSchema,
  exerciseOptionSchema,
  grantEquityCompensationSchema,
  recordRepurchaseDryRunSchema,
  recordRepurchaseSchema,
  markExecutedSchema,
  reverseCommandSchema,
  scheduleTerminationSchema,
  terminateStakeholderDryRunSchema,
  terminateStakeholderSchema,
} from "../../../src/app/shared/api/commands.ts";
import { DEFAULT_ORG_SETTINGS, orgSettingsSchema, patchOrgRequestSchema } from "../../../src/app/shared/api/orgs.ts";
import { createStakeholderRequestSchema, patchStakeholderRequestSchema } from "../../../src/app/shared/api/stakeholders.ts";
import { ENDPOINT_EXAMPLES } from "./endpoint-examples.ts";
import { COMMAND_ID, guard, OPTION_ID, STAKEHOLDER_ID } from "./fixtures.ts";

describe("the command envelope", () => {
  it("requires the reviewed ledger seq and diff on a real call, not on a dry run", () => {
    expect(commandEnvelopeSchema.safeParse({}).success).toBe(false);
    expect(commandEnvelopeSchema.parse(guard)).toEqual({ ...guard, acknowledge: [], documentIds: [] });
    expect(dryRunEnvelopeSchema.parse({})).toEqual({ acknowledge: [], documentIds: [] });
  });

  it("caps supporting documents at 20 and refuses a malformed diff", () => {
    const ids = Array.from({ length: 21 }, () => OPTION_ID);
    expect(commandEnvelopeSchema.safeParse({ ...guard, documentIds: ids }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ ...guard, expectedDiffSha256: "ab" }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ ...guard, expectedLedgerSeq: -1 }).success).toBe(false);
  });
});

describe("terminate-stakeholder and schedule-termination", () => {
  const minimal = { stakeholderId: STAKEHOLDER_ID, terminationDate: "2026-12-04", terminationType: "with_cause" };

  it("defaults to ex_employee and no extras", () => {
    expect(terminateStakeholderDryRunSchema.parse(minimal)).toEqual({
      ...minimal,
      relationshipAfter: "ex_employee",
      accelerations: [],
      deadlineExtensions: [],
      repurchaseDeadlines: [],
      acknowledge: [],
      documentIds: [],
    });
  });

  it("schedule with the reviewed diff, the seq being optional", () => {
    expect(scheduleTerminationSchema.safeParse({ ...minimal, expectedDiffSha256: guard.expectedDiffSha256 }).success).toBe(true);
    expect(scheduleTerminationSchema.safeParse({ ...minimal, expectedLedgerSeq: 412 }).success).toBe(false);
  });
});

describe("exercise-option", () => {
  const body = ENDPOINT_EXAMPLES.exerciseOption.body as Record<string, unknown> & { payment: Record<string, unknown> };

  it("defaults the payer to the holder and needs a note otherwise", () => {
    expect(exerciseOptionSchema.parse(body).payment.payerIsHolder).toBe(true);
    const otherPayer = { ...body, payment: { ...body.payment, payerIsHolder: false } };
    expect(exerciseOptionSchema.safeParse(otherPayer).error?.issues.map((issue) => issue.path.join("."))).toEqual(["payment.payerNote"]);
    expect(exerciseOptionSchema.safeParse({ ...otherPayer, payment: { ...otherPayer.payment, payerNote: "Paid by the holder's trust" } }).success).toBe(true);
  });

  it("takes at most one ISO and one NSO portion", () => {
    expect(exerciseOptionSchema.safeParse({ ...body, resultingShares: [{ portion: "ISO" }, { portion: "NSO" }] }).success).toBe(true);
    expect(exerciseOptionSchema.safeParse({ ...body, resultingShares: [{ portion: "NSO" }, { portion: "NSO" }] }).success).toBe(false);
  });

  it("takes the FMV from a valuation or as a documented manual price", () => {
    const manual = { source: "manual", pricePerShare: "1.2", sourceNote: "Board determination", documentId: COMMAND_ID };
    expect(exerciseOptionSchema.safeParse({ ...body, fmv: manual }).success).toBe(true);
    expect(exerciseOptionSchema.safeParse({ ...body, fmv: { ...manual, source: "guess" } }).success).toBe(false);
  });
});

describe("grant-equity-compensation", () => {
  const body = ENDPOINT_EXAMPLES.grantEquityCompensation.body as Record<string, unknown> & { board: { approvalDate: string } };

  it("needs the ISO attestations for an ISO only", () => {
    const { isoAttestations: _attestations, ...withoutAttestations } = body;
    expect(grantEquityCompensationSchema.safeParse(withoutAttestations).success).toBe(false);
    expect(grantEquityCompensationSchema.safeParse({ ...withoutAttestations, optionType: "NSO" }).success).toBe(true);
  });

  it("needs a reason when the grant date isn't the board approval date", () => {
    expect(grantEquityCompensationSchema.safeParse({ ...body, grantDate: body.board.approvalDate }).success).toBe(true);
    expect(grantEquityCompensationSchema.safeParse({ ...body, grantDate: "2026-12-11" }).success).toBe(false);
    expect(grantEquityCompensationSchema.safeParse({ ...body, grantDate: "2026-12-11", grantDateOverrideReason: "Signed the next day" }).success).toBe(true);
  });

  it("is executed with the agreement signed by both, or recorded awaiting signatures, exactly one of the two", () => {
    const { executedAgreement: _executed, ...awaiting } = body;
    const paths = (value: unknown) => grantEquityCompensationSchema.safeParse(value).error?.issues.map((issue) => issue.path.join(".")) ?? [];
    expect(paths(awaiting)).toEqual(["executedAgreement"]);
    expect(paths({ ...body, awaitingSignatures: { missing: "holder" } })).toEqual(["awaitingSignatures"]);
    for (const missing of ["holder", "both"]) expect(paths({ ...awaiting, awaitingSignatures: { missing } }), missing).toEqual([]);
    // Awaiting only the company signatory, the grant can be exercised: the holder-signed agreement is required.
    expect(paths({ ...awaiting, awaitingSignatures: { missing: "company" } })).toEqual(["awaitingSignatures.agreementDocumentId"]);
    expect(paths({ ...awaiting, awaitingSignatures: { missing: "company", agreementDocumentId: COMMAND_ID } })).toEqual([]);
    expect(paths({ ...awaiting, awaitingSignatures: { missing: "nobody" } })).toEqual(["awaitingSignatures.missing"]);
  });

  it("takes vesting from a template or from explicit tranches, not both", () => {
    const vesting = body.vesting as Record<string, unknown>;
    const explicit = { explicit: [{ date: "2027-12-10", quantity: "48000" }] };
    expect(grantEquityCompensationSchema.safeParse({ ...body, vesting: { ...vesting, terms: explicit } }).success).toBe(true);
    expect(grantEquityCompensationSchema.safeParse({ ...body, vesting: { ...vesting, terms: { ...explicit, templateId: COMMAND_ID } } }).success).toBe(false);
  });
});

describe("record-repurchase", () => {
  const body = ENDPOINT_EXAMPLES.recordRepurchase.body as Record<string, unknown> & { consideration: Record<string, unknown> };

  it("takes the notice, how it was paid and an optional authority, and refuses what isn't a completed payment", () => {
    expect(recordRepurchaseSchema.parse(body)).toMatchObject({ documentIds: [], acknowledge: [], consideration: { method: "CHECK", paidDate: "2026-11-20" } });
    expect(recordRepurchaseSchema.safeParse({ ...body, authorityDocumentId: COMMAND_ID }).success).toBe(true);
    for (const method of ["CASH", "CHECK", "WIRE", "ACH", "OTHER"]) {
      expect(recordRepurchaseSchema.safeParse({ ...body, consideration: { method, paidDate: "2026-11-20" } }).success, method).toBe(true);
    }
    expect(recordRepurchaseSchema.safeParse({ ...body, consideration: { ...body.consideration, method: "MANUAL_UNSPECIFIED" } }).success).toBe(false);
    expect(recordRepurchaseSchema.safeParse({ ...body, consideration: { method: "WIRE" } }).success).toBe(false);
    expect(recordRepurchaseSchema.safeParse({ ...body, pricePerShare: "0" }).success).toBe(false);
    const { noticeDocumentId: _notice, ...withoutNotice } = body;
    expect(recordRepurchaseSchema.safeParse(withoutNotice).success).toBe(false);
  });

  it("needs the typed display ID on the real call only", () => {
    const { confirmation: _typed, expectedLedgerSeq: _seq, expectedDiffSha256: _diff, ...dryRun } = body;
    expect(recordRepurchaseDryRunSchema.safeParse(dryRun).success).toBe(true);
    expect(recordRepurchaseSchema.safeParse({ ...dryRun, expectedLedgerSeq: 412, expectedDiffSha256: guard.expectedDiffSha256 }).success).toBe(false);
  });
});

describe("mark-executed", () => {
  const body = ENDPOINT_EXAMPLES.markExecuted.body as Record<string, unknown>;
  const paths = (value: unknown) => markExecutedSchema.safeParse(value).error?.issues.map((issue) => issue.path.join(".")) ?? [];

  it("records both signatures by default, as before", () => {
    expect(markExecutedSchema.parse(body).signed).toBe("both");
  });

  it("records one party's signature with that party's attestation and date only", () => {
    const holder = { ...body, signed: "holder", signatureDates: { holder: "2026-12-08" }, attestation: "This PDF bears the holder's signature" };
    expect(paths(holder)).toEqual([]);
    expect(paths({ ...holder, attestation: "This PDF bears both signatures" })).toEqual(["attestation"]);
    expect(paths({ ...holder, signatureDates: { company: "2026-12-08" } })).toEqual(["signatureDates.company"]);
    const company = { ...body, signed: "company", signatureDates: { company: "2026-12-08" }, attestation: "This PDF bears the company signatory's signature" };
    expect(paths(company)).toEqual([]);
    expect(paths({ ...company, signatureDates: { holder: "2026-12-08" } })).toEqual(["signatureDates.holder"]);
    expect(paths({ ...body, signed: "nobody" })).toEqual(["signed"]);
  });
});

describe("reverse-command", () => {
  it("needs the reason", () => {
    const body = { commandId: COMMAND_ID, note: "Wrong grant", ...guard, confirmation: "OPT-7" };
    expect(reverseCommandSchema.parse(body).commandId).toBe(COMMAND_ID);
    expect(reverseCommandSchema.safeParse({ ...body, note: " " }).success).toBe(false);
  });
});

describe("edits change only what they send", () => {
  it("a stakeholder PATCH applies none of the create defaults", () => {
    // Building the patch schema from the create schema's partial form would retain create defaults. The dedicated
    // patch contract applies none of them.
    expect(patchStakeholderRequestSchema.parse({ version: 2, phone: "+1 555 0199" })).toEqual({ version: 2, phone: "+1 555 0199" });
    const created = createStakeholderRequestSchema.parse({
      kind: "individual",
      displayName: "Dana Example",
      relationship: "employee",
      emails: [{ email: "dana@mailbox.example" }],
    });
    expect(created).toMatchObject({ taxStatus: "unknown" });
    expect(created.emails[0]).toEqual({ email: "dana@mailbox.example", kind: "self" });
  });

  it("uses null only to clear nullable stakeholder profile fields", () => {
    const nullable = [
      "legalName", "issuerAssignedId", "address", "phone", "countryOfResidence", "hireDate", "comments",
    ] as const;
    for (const field of nullable) {
      expect(patchStakeholderRequestSchema.safeParse({ version: 1, [field]: null }).success, field).toBe(true);
    }
    const required = ["version", "kind", "displayName", "relationship", "taxStatus", "portalAccess"] as const;
    for (const field of required) {
      expect(patchStakeholderRequestSchema.safeParse({ version: 1, phone: "+1 555 0199", [field]: null }).success, field)
        .toBe(false);
    }
  });

  it("an org PATCH needs something to change", () => {
    expect(patchOrgRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(patchOrgRequestSchema.safeParse({ version: 1, ein: null }).success).toBe(true);
  });

  it("the default org settings are valid and expiry starts report-only", () => {
    expect(orgSettingsSchema.parse(DEFAULT_ORG_SETTINGS)).toEqual(DEFAULT_ORG_SETTINGS);
    expect(DEFAULT_ORG_SETTINGS.expiry.mode).toBe("report_only");
  });
});
