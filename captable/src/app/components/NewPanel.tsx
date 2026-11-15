import { Link } from "react-router";
import { Plus } from "lucide-react";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item.tsx";
import { Modal } from "./Dialog.tsx";

// The "+ New" panel, after Pulley's three-card "Add contracts" panel: the app keeps the first card, an existing contract
// recorded as Options. It has no e-signature or certificate issuance, so those two cards aren't shown.

export function NewPanel({ companyBase, onClose }: { companyBase: string; onClose: () => void }) {
  return (
    <Modal title="Add contracts" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">Add an option grant to the cap table</h3>
          <p className="text-xs text-muted-foreground">Record an option grant approved by the board, whether its agreement is signed or still awaits a signature.</p>
        </div>
        <Item asChild variant="outline">
          <Link to={`${companyBase}/issue/options?mode=existing`} onClick={onClose}>
            <ItemMedia variant="icon"><Plus aria-hidden="true" /></ItemMedia>
            <ItemContent>
              <ItemTitle>Options</ItemTitle>
              <ItemDescription>ISO or NSO grant · Single</ItemDescription>
            </ItemContent>
          </Link>
        </Item>
        <p className="text-right text-xs font-semibold text-primary">Existing contract</p>
      </div>
    </Modal>
  );
}
