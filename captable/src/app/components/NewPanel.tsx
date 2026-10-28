import { Link } from "react-router";
import { Modal } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";

// The "+ New" panel, after Pulley's three-card "Add contracts" panel: the app keeps the first card, an existing contract
// recorded as Options. It has no e-signature or certificate issuance, so those two cards aren't shown.

export function NewPanel({ companyBase, onClose }: { companyBase: string; onClose: () => void }) {
  return (
    <Modal title="Add contracts" onClose={onClose}>
      <div className="new-card">
        <h3 className="mb-8">Add a signed agreement to the cap table</h3>
        <p className="small muted">Record an option grant that is already approved by the board and signed by the holder and the company signatory.</p>
        <Link className="new-option" to={`${companyBase}/issue/options?mode=existing`} onClick={onClose}>
          <Icon name="plus" />
          <span><span className="rc-t" style={{ display: "block", fontWeight: 600 }}>Options</span><span className="small muted">ISO or NSO grant · Single</span></span>
        </Link>
        <p className="small" style={{ marginTop: 12, textAlign: "right", color: "var(--primary)", fontWeight: 650 }}>Existing contract</p>
      </div>
    </Modal>
  );
}
