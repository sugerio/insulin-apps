import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { compareDecimals, formatFractionPercent, fractionOf, fromUnits, isPositive, multiplyDecimals, toUnits } from "../lib/decimal.ts";
import { allOf, useResource } from "../lib/useResource.ts";
import { DescriptionList } from "./DescriptionList.tsx";
import { DismissButton, Modal } from "./Dialog.tsx";
import { InlineError } from "./Feedback.tsx";
import { AmountField, SelectField } from "./Form.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";

// The % shares calculator: what a target share of the company comes to, read-only and for admins (fully diluted
// figures never reach the holder view). Options needed = floor(fully diluted × target %), with no gross-up: fully
// diluted already counts the unissued pool a grant comes from. The value uses a preferred class's original issue price,
// the cost the common FMV of the 409A in effect today. Exact decimals throughout; nothing is recorded.

const ONE = toUnits("1");
/** A percentage as typed: up to 6 decimals, above 0 and at most 100. */
const PERCENT = /^\d{1,3}(?:\.\d{1,6})?$/;

/** The whole options that come to at most `percent`% of `fullyDiluted`. */
export function optionsForPercent(fullyDiluted: string, percent: string): string {
  return fromUnits(((toUnits(fullyDiluted) * toUnits(percent)) / (ONE * 100n) / ONE) * ONE);
}

function percentError(value: string): string | null {
  if (value.trim() === "") return "Enter a percentage.";
  if (!PERCENT.test(value.trim())) return "Enter a percentage such as 0.25, with at most 6 decimals.";
  if (!isPositive(value.trim()) || compareDecimals(value.trim(), "100") > 0) return "Enter a percentage above 0 and at most 100.";
  return null;
}

export function SharesCalculatorDialog({ fullyDiluted, onClose }: { fullyDiluted: string; onClose: () => void }) {
  const { orgId, format, today } = useWorkspace();
  const classes = useResource((signal) => apiRequest(api.routes.listStockClasses, { params: { orgId }, signal }), [orgId]);
  const fmv = useResource((signal) => apiRequest(api.routes.getFmv, { params: { orgId }, query: { date: today }, signal }), [orgId, today]);
  const [percent, setPercent] = useState("");
  const [classId, setClassId] = useState<string | null>(null);
  const loaded = allOf(classes, fmv);
  const error = percentError(percent);
  const preferred = (classes.data?.items ?? []).filter((item) => item.classType === "PREFERRED" && item.originalIssuePrice !== null);
  // The latest round is the usual yardstick: the highest original issue price, until another class is chosen.
  const chosen = preferred.find((item) => item.id === classId)
    ?? [...preferred].sort((a, b) => compareDecimals(b.originalIssuePrice, a.originalIssuePrice))[0] ?? null;
  const options = error ? null : optionsForPercent(fullyDiluted, percent.trim());
  const commonFmv = fmv.data?.fmv ?? null;

  return (
    <Modal title="% shares calculator" onClose={onClose} footer={<DismissButton onClick={onClose}>Close</DismissButton>}>
      <p className="small muted">
        How many options a share of the company comes to, what they are worth at a preferred price, and what they cost to exercise at today's 409A FMV. Estimate — not
        tax advice. Nothing is recorded.
      </p>
      <div className="form">
        <AmountField label="Target % of fully diluted" placeholder="0.25" value={percent} onChange={setPercent} suffix="%"
          hint={`Of ${format.shares(fullyDiluted)} fully diluted shares today, which already count the unissued pool.`} error={percent !== "" && error ? error : undefined} />
        {preferred.length ? (
          <SelectField label="Value at the price of" value={chosen?.id ?? ""} onChange={setClassId}
            options={preferred.map((item) => [item.id, `${item.name} (${format.price(item.originalIssuePrice)})`] as const)} />
        ) : null}
      </div>
      {loaded.data === undefined ? (
        loaded.error !== undefined ? <InlineError what="the prices" error={loaded.error} onRetry={loaded.reload} /> : <p className="muted small" role="status">Loading the prices…</p>
      ) : options === null ? null : (
        <div className="review-panel mt-12">
          <DescriptionList
            split
            label="Estimate"
            rows={[
              ["Options needed", format.shares(options)],
              ["Share of fully diluted", formatFractionPercent(fractionOf(options, fullyDiluted), 4)],
              chosen
                ? [`Value at ${chosen.name} price (${format.price(chosen.originalIssuePrice)})`, format.money(multiplyDecimals(options, chosen.originalIssuePrice))]
                : ["Value at a preferred price", "No preferred class has an original issue price"],
              commonFmv
                ? [`Cost to exercise at the 409A FMV (${format.price(commonFmv.pricePerShare)})`, format.money(multiplyDecimals(options, commonFmv.pricePerShare))]
                : ["Cost to exercise", "No 409A is in effect today"],
            ]}
          />
        </div>
      )}
    </Modal>
  );
}
