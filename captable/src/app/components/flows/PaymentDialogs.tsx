import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { fieldProblem, useWriteFlow } from "../../lib/flow.ts";
import { DescriptionList } from "../DescriptionList.tsx";
import { TextAreaField, TextField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// The payment instructions holders see on How to exercise: set by an owner or admin, one current version, audited by
// the server. Saving replaces the whole set of details, and carries the `updatedAt` of the version it replaces: if
// someone saved in between, the server answers 409 stale_version and the dialog reads the current version again.

export interface PaymentValues {
  bankName: string;
  beneficiaryName: string;
  beneficiaryAddress: string;
  accountNumber: string;
  routingNumber: string;
  swift: string;
  iban: string;
  intermediaryBank: string;
  checkPayee: string;
  checkMailingAddress: string;
  referenceFormat: string;
}

type PaymentErrors = Partial<Record<keyof PaymentValues, string>>;

const OPTIONAL = ["routingNumber", "swift", "iban", "intermediaryBank", "checkPayee", "checkMailingAddress"] as const;

const LIMITS: Record<keyof PaymentValues, number> = {
  bankName: 200, beneficiaryName: 200, beneficiaryAddress: 500, accountNumber: 34, routingNumber: 9, swift: 11, iban: 34,
  intermediaryBank: 500, checkPayee: 200, checkMailingAddress: 500, referenceFormat: 100,
};

export const PAYMENT_LABELS: Record<keyof PaymentValues, string> = {
  bankName: "Bank", beneficiaryName: "Beneficiary", beneficiaryAddress: "Beneficiary address", accountNumber: "Account number",
  routingNumber: "Routing number", swift: "SWIFT", iban: "IBAN", intermediaryBank: "Intermediary bank (international wires)",
  checkPayee: "Checks payable to", checkMailingAddress: "Check mailing address", referenceFormat: "Reference format",
};

export function paymentValues(details: api.PaymentInstructionDetails | null | undefined): PaymentValues {
  return {
    bankName: details?.bankName ?? "",
    beneficiaryName: details?.beneficiaryName ?? "",
    beneficiaryAddress: details?.beneficiaryAddress ?? "",
    accountNumber: details?.accountNumber ?? "",
    routingNumber: details?.routingNumber ?? "",
    swift: details?.swift ?? "",
    iban: details?.iban ?? "",
    intermediaryBank: details?.intermediaryBank ?? "",
    checkPayee: details?.checkPayee ?? "",
    checkMailingAddress: details?.checkMailingAddress ?? "",
    referenceFormat: details?.referenceFormat ?? "",
  };
}

/** The checks the contract makes, in words; the server still has the last word. */
export function validatePayment(values: PaymentValues): PaymentErrors {
  const errors: PaymentErrors = {};
  for (const key of ["bankName", "beneficiaryName", "beneficiaryAddress", "accountNumber", "referenceFormat"] as const) {
    if (!values[key].trim()) errors[key] = `Enter the ${PAYMENT_LABELS[key].toLowerCase()}.`;
  }
  for (const key of Object.keys(LIMITS) as (keyof PaymentValues)[]) {
    if (!errors[key] && values[key].trim().length > LIMITS[key]) errors[key] = `At most ${LIMITS[key]} characters.`;
  }
  if (values.routingNumber.trim() && !/^\d{9}$/.test(values.routingNumber.trim())) errors.routingNumber = "A routing number has 9 digits.";
  if (values.swift.trim() && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(values.swift.trim().toUpperCase())) errors.swift = "A SWIFT code has 8 or 11 letters and digits.";
  if (values.accountNumber.includes("•")) errors.accountNumber = "Enter the whole account number: the shown one is masked.";
  if (values.iban.includes("•")) errors.iban = "Enter the whole IBAN: the shown one is masked.";
  return errors;
}

/** The details as sent: trimmed, the optional ones left out when empty. */
export function paymentDetails(values: PaymentValues): api.PaymentInstructionDetails {
  const optional = Object.fromEntries(
    OPTIONAL.flatMap((key) => {
      const value = key === "swift" ? values[key].trim().toUpperCase() : values[key].trim();
      return value ? [[key, value]] : [];
    }),
  );
  return {
    bankName: values.bankName.trim(),
    beneficiaryName: values.beneficiaryName.trim(),
    beneficiaryAddress: values.beneficiaryAddress.trim(),
    accountNumber: values.accountNumber.trim(),
    referenceFormat: values.referenceFormat.trim(),
    ...optional,
  };
}

function sameDetails(left: api.PaymentInstructionDetails, right: api.PaymentInstructionDetails): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof api.PaymentInstructionDetails>;
  return [...keys].every((key) => (left[key] ?? "") === (right[key] ?? ""));
}

export function PaymentInstructionsDialog({ current, onClose, onDone }: { current: api.PaymentInstruction | null; onClose: () => void; onDone: (saved: api.PaymentInstruction) => void }) {
  const { orgId, format } = useWorkspace();
  const toast = useToast();
  // The version this save replaces (null when there is none yet); a stale answer reads it again.
  const [base, setBase] = useState<api.PaymentInstruction | null>(current);
  const [values, setValues] = useState<PaymentValues>(() => paymentValues(current?.details));
  const [errors, setErrors] = useState<PaymentErrors>({});
  const set = (key: keyof PaymentValues, value: string) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
  };
  const flow = useWriteFlow({
    request: () => ({ details: paymentDetails(values), updatedAt: base?.updatedAt ?? null }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.setPaymentInstructions, { params: { orgId }, body, idempotencyKey: key }),
    // After a stale answer: the current version becomes the base. Fields the admin didn't touch take its values, so a
    // concurrent change is never overwritten unseen; the admin's own edits are kept, and the review shows the result.
    refresh: async () => {
      const fresh = await apiRequest(api.routes.getPaymentInstructions, { params: { orgId } });
      const was = paymentValues(base?.details);
      const now = paymentValues(fresh?.details);
      setValues((typed) => {
        const next = { ...typed };
        for (const key of Object.keys(typed) as (keyof PaymentValues)[]) if (typed[key] === was[key]) next[key] = now[key];
        return next;
      });
      setBase(fresh);
    },
    // After a lost answer: the version it replaced still current means nothing was written; a newer one with these
    // details is this save; a newer one with other details can't tell, so the same request may only be retried.
    reconcile: async ({ request }) => {
      const stored = await apiRequest(api.routes.getPaymentInstructions, { params: { orgId } });
      if ((stored?.updatedAt ?? null) === request.updatedAt) return "not_recorded";
      return stored && sameDetails(stored.details, request.details) ? { result: stored } : "unknown";
    },
    fields: { issue: (path) => (path.startsWith("details.") ? path.slice("details.".length) : null) },
    onCommitted: (saved) => {
      toast({ message: "Payment instructions saved — holders see them on How to exercise" });
      onDone(saved);
    },
  });
  const review = () => {
    const found = validatePayment(values);
    if (!Object.keys(found).length && base && sameDetails(base.details, paymentDetails(values))) found.bankName = "Nothing has changed.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: keyof PaymentValues) => errors[key] ?? fieldProblem(flow.problem, key);
  const reviewed = flow.request?.details;
  const field = (key: keyof PaymentValues, options: { required?: boolean; hint?: string; placeholder?: string } = {}) => (
    <TextField label={PAYMENT_LABELS[key]} required={options.required} value={values[key]} onChange={(value) => set(key, value)} hint={options.hint} placeholder={options.placeholder} error={errorOf(key)} />
  );
  return (
    <FlowDialog
      title={current ? "Edit payment instructions" : "Set payment instructions"}
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Save instructions"
      review={reviewed ? (
        <div className="review-panel" aria-label="Review">
          <p>
            Holders see these details on How to exercise
            {base ? `, instead of the ones ${base.updatedBy ?? "an admin"} saved ${format.dateTime(base.updatedAt)}` : ""}:
          </p>
          <DescriptionList rows={(Object.keys(PAYMENT_LABELS) as (keyof PaymentValues)[]).filter((key) => reviewed[key]).map((key) => [PAYMENT_LABELS[key], reviewed[key]!])} />
        </div>
      ) : null}
    >
      <div className="form-grid">
        {field("bankName", { required: true })}
        {field("beneficiaryName", { required: true })}
      </div>
      <TextAreaField label={PAYMENT_LABELS.beneficiaryAddress} required value={values.beneficiaryAddress} onChange={(value) => set("beneficiaryAddress", value)} error={errorOf("beneficiaryAddress")} />
      <div className="form-grid">
        {field("accountNumber", { required: true })}
        {field("routingNumber", { hint: "9 digits, for US transfers." })}
        {field("swift", { hint: "8 or 11 characters, for international wires." })}
        {field("iban")}
      </div>
      {field("intermediaryBank")}
      <div className="form-grid">
        {field("checkPayee")}
        {field("checkMailingAddress")}
      </div>
      {field("referenceFormat", { required: true, placeholder: "EX-<grant>-<initials>", hint: "What holders quote with a payment, so it can be matched to their exercise." })}
    </FlowDialog>
  );
}
