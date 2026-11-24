import { Button } from "@/components/ui/button.tsx";
import { formatMoney } from "../lib/format.ts";
import { cleanAmount } from "./AmountField.tsx";

/** A starting amount the rules work out from documents (a suggest line), offered under an amount until it is used. */
export function SuggestionNote({
  suggestion,
  value,
  editable,
  busy,
  onChange,
}: {
  suggestion: string | null;
  value: string;
  editable: boolean;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  if (suggestion === null) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      From your documents: {formatMoney(suggestion)}.
      {editable && cleanAmount(value) !== suggestion ? (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onChange(suggestion)} disabled={busy}>
          Use {formatMoney(suggestion)}
        </Button>
      ) : null}
    </p>
  );
}
