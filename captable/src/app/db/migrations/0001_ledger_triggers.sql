-- What drizzle-kit can't express: the transaction_types seed and the triggers that guard the ledger and the records
-- (append-only tables, `version` = old + 1, state transitions, the ledger head, reversal rules). SQLite fires the most
-- recently created trigger first, so when several guards on one table would abort, the last one created names the
-- error: keep this order when re-creating a trigger. One statement per breakpoint, each safe to run again: publishing
-- applies a migration one statement at a time and, after a failure midway, runs it again from the start.
INSERT OR IGNORE INTO transaction_types (code, family, is_ocf, description) VALUES
  ('TX_STOCK_ISSUANCE', 'STOCK', 1, 'Shares issued (purchase, founders, RSA, or the result of an exercise, conversion, transfer or release)'),
  ('TX_STOCK_TRANSFER', 'STOCK', 1, 'Shares move to one or more holders; resulting lots and an optional balance lot'),
  ('TX_STOCK_CANCELLATION', 'STOCK', 1, 'Shares cancelled (all or part; optional balance lot)'),
  ('TX_STOCK_REPURCHASE', 'STOCK', 1, 'Company buys back shares (a forfeiture is a repurchase at 0)'),
  ('TX_STOCK_CONVERSION', 'STOCK', 1, 'Shares converted or reclassified into another class'),
  ('TX_STOCK_REISSUANCE', 'STOCK', 1, 'Lot re-issued (e.g. lost certificate replaced)'),
  ('TX_STOCK_RETRACTION', 'STOCK', 1, 'Issuance retracted: it never legally happened'),
  ('TX_STOCK_ACCEPTANCE', 'STOCK', 1, 'Holder accepted the shares or certificate'),
  ('TX_EQUITY_COMPENSATION_ISSUANCE', 'EQUITY_COMPENSATION', 1, 'Option (ISO/NSO), RSU or SAR granted'),
  ('TX_EQUITY_COMPENSATION_EXERCISE', 'EQUITY_COMPENSATION', 1, 'Option exercised into shares (resulting stock issuances)'),
  ('TX_EQUITY_COMPENSATION_CANCELLATION', 'EQUITY_COMPENSATION', 1, 'Award cancelled in whole or part (termination, expiry, forfeiture, waiver)'),
  ('TX_EQUITY_COMPENSATION_RELEASE', 'EQUITY_COMPENSATION', 1, 'RSUs settled into shares (net of withholding)'),
  ('TX_EQUITY_COMPENSATION_TRANSFER', 'EQUITY_COMPENSATION', 1, 'Award transferred (e.g. on death or to a trust)'),
  ('TX_EQUITY_COMPENSATION_RETRACTION', 'EQUITY_COMPENSATION', 1, 'Grant retracted: it never legally happened'),
  ('TX_EQUITY_COMPENSATION_ACCEPTANCE', 'EQUITY_COMPENSATION', 1, 'Holder accepted the grant'),
  ('TX_WARRANT_ISSUANCE', 'WARRANT', 1, 'Warrant issued'),
  ('TX_WARRANT_EXERCISE', 'WARRANT', 1, 'Warrant exercised into shares'),
  ('TX_WARRANT_CANCELLATION', 'WARRANT', 1, 'Warrant cancelled or expired'),
  ('TX_WARRANT_TRANSFER', 'WARRANT', 1, 'Warrant transferred'),
  ('TX_WARRANT_RETRACTION', 'WARRANT', 1, 'Warrant retracted'),
  ('TX_WARRANT_ACCEPTANCE', 'WARRANT', 1, 'Holder accepted the warrant'),
  ('TX_CONVERTIBLE_ISSUANCE', 'CONVERTIBLE', 1, 'SAFE or convertible note issued'),
  ('TX_CONVERTIBLE_CONVERSION', 'CONVERTIBLE', 1, 'SAFE or note converted into shares'),
  ('TX_CONVERTIBLE_CANCELLATION', 'CONVERTIBLE', 1, 'SAFE or note cancelled (repaid, terminated)'),
  ('TX_CONVERTIBLE_TRANSFER', 'CONVERTIBLE', 1, 'SAFE or note transferred (all or part)'),
  ('TX_CONVERTIBLE_RETRACTION', 'CONVERTIBLE', 1, 'SAFE or note retracted'),
  ('TX_CONVERTIBLE_ACCEPTANCE', 'CONVERTIBLE', 1, 'Holder accepted the SAFE or note'),
  ('TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT', 'STOCK_CLASS', 1, 'Authorized shares of a class set (initial or charter amendment)'),
  ('TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT', 'STOCK_CLASS', 1, 'Conversion ratio of a preferred class changed'),
  ('TX_STOCK_CLASS_SPLIT', 'STOCK_CLASS', 1, 'Split of a class: scales issued instruments only; authorized shares change only by an explicit adjustment'),
  ('TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT', 'ISSUER', 1, 'Total authorized shares of the company set'),
  ('TX_STOCK_PLAN_POOL_ADJUSTMENT', 'STOCK_PLAN', 1, 'Shares reserved under a plan set (initial or amendment)'),
  ('TX_STOCK_PLAN_RETURN_TO_POOL', 'STOCK_PLAN', 1, 'Shares explicitly returned to a plan pool'),
  ('TX_VESTING_START', 'VESTING', 1, 'Vesting commencement recorded for a security'),
  ('TX_VESTING_EVENT', 'VESTING', 1, 'A vesting condition was met for a security'),
  ('TX_VESTING_ACCELERATION', 'VESTING', 1, 'Vesting accelerated by a quantity'),
  ('X_STOCK_CLASS_TERMS', 'STOCK_CLASS', 0, 'Effective-dated economic terms of a class: votes per share, exclusion from FD, preference, participation, seniority, dividends, anti-dilution'),
  ('X_STOCK_PLAN_TERMS', 'STOCK_PLAN', 0, 'Effective-dated plan terms: the five return-to-pool rules, default exit windows, default repurchase window, status and pour-over'),
  ('X_EQUITY_COMPENSATION_REPRICING', 'EQUITY_COMPENSATION', 0, 'Exercise price changed; represented as a ledger extension because OCF v1.2.0 has no repricing object type'),
  ('X_VESTING_PAUSE', 'VESTING', 0, 'Vesting paused from an effective date'),
  ('X_VESTING_RESUME', 'VESTING', 0, 'Paused vesting resumed from an effective date'),
  ('X_STAKEHOLDER_TERMINATION', 'STAKEHOLDER', 0, 'Service ended: type, termination date, vesting stop date, ISO-deadline attestations (OCF relationship change on export)'),
  ('X_STAKEHOLDER_LEAVE', 'STAKEHOLDER', 0, 'Leave of absence (start, end, right to return) for the ISO deadline'),
  ('X_EXECUTION_STATUS', 'LEDGER', 0, 'Execution status of a security (executed, pending: company, holder or both, not required) with its evidence; gates exercise; Mark executed appends one'),
  ('X_SECURITY_MODIFICATION', 'LEDGER', 0, 'Legal modification of terms other than price, e.g. a counsel-approved extension of the contractual exercise deadline'),
  ('X_REVERSAL', 'LEDGER', 0, 'Voids one transaction of a command; a reverse-command appends one per transaction of the target command'),
  ('X_CORRECTION', 'LEDGER', 0, 'Clerical correction that replaces an earlier payload while preserving both records'),
  ('X_MIGRATION_OPENING_BALANCE', 'MIGRATION', 0, 'Opening position for an imported lot when earlier transaction history is unavailable; evidence is the source snapshot'),
  ('X_STAKEHOLDER_MERGE', 'STAKEHOLDER', 0, 'Identity fact: one duplicate stakeholder record is the same person as the surviving record');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS batch_assertions_check BEFORE INSERT ON batch_assertions
BEGIN
  SELECT RAISE(ABORT, 'batch assertion failed') WHERE NEW.ok IS NOT 1;
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS users_version BEFORE UPDATE ON users WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS orgs_version BEFORE UPDATE ON orgs WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS orgs_key_and_slug BEFORE UPDATE ON orgs
WHEN NEW.org_key IS NOT OLD.org_key OR NEW.slug IS NOT OLD.slug
BEGIN SELECT RAISE(ABORT, 'the company key and slug never change'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS orgs_share_unit_frozen BEFORE UPDATE OF share_unit ON orgs
WHEN NEW.share_unit IS NOT OLD.share_unit AND EXISTS (SELECT 1 FROM transactions WHERE org_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'share_unit is frozen once the org has transactions'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS orgs_no_delete BEFORE DELETE ON orgs
BEGIN SELECT RAISE(ABORT, 'the company is never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS ledger_heads_follow_transactions BEFORE UPDATE ON ledger_heads
WHEN NEW.seq IS NOT OLD.seq + 1 OR NEW.genesis_hash IS NOT OLD.genesis_hash
  OR NEW.head_hash IS NOT (SELECT chain_hash FROM transactions WHERE org_id = NEW.org_id AND seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'the ledger head moves only with a new transaction'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS ledger_heads_no_delete BEFORE DELETE ON ledger_heads
BEGIN SELECT RAISE(ABORT, 'ledger heads are never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stakeholders_version BEFORE UPDATE ON stakeholders WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stakeholders_no_delete BEFORE DELETE ON stakeholders
BEGIN SELECT RAISE(ABORT, 'stakeholders are archived, never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stakeholder_emails_no_delete BEFORE DELETE ON stakeholder_emails
BEGIN SELECT RAISE(ABORT, 'e-mails are removed (removed_at), never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stock_classes_version BEFORE UPDATE ON stock_classes WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stock_classes_no_delete BEFORE DELETE ON stock_classes
BEGIN SELECT RAISE(ABORT, 'classes are archived, never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stock_plans_version BEFORE UPDATE ON stock_plans WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stock_plans_no_delete BEFORE DELETE ON stock_plans
BEGIN SELECT RAISE(ABORT, 'plans are archived, never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vesting_terms_immutable BEFORE UPDATE ON vesting_terms
WHEN NEW.definition IS NOT OLD.definition OR NEW.definition_sha256 IS NOT OLD.definition_sha256
  OR NEW.algorithm_version IS NOT OLD.algorithm_version OR NEW.org_id IS NOT OLD.org_id OR NEW.template_id IS NOT OLD.template_id
  OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
BEGIN SELECT RAISE(ABORT, 'vesting terms are immutable; create a new row'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS vesting_terms_no_delete BEFORE DELETE ON vesting_terms
BEGIN SELECT RAISE(ABORT, 'vesting terms are never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS legends_version BEFORE UPDATE ON legends WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS org_signatories_version BEFORE UPDATE ON org_signatories WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS idempotency_keys_immutable BEFORE UPDATE ON idempotency_keys
BEGIN SELECT RAISE(ABORT, 'idempotency receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS commands_claim_next_seq BEFORE INSERT ON commands
BEGIN
  SELECT RAISE(ABORT, 'stale ledger: first_seq must be head + 1')
  WHERE NEW.first_seq IS NOT (SELECT seq + 1 FROM ledger_heads WHERE org_id = NEW.org_id);
  SELECT RAISE(ABORT, 'stale ledger: the head moved since the dry run')
  WHERE NEW.expected_ledger_seq IS NOT NULL AND NEW.expected_ledger_seq IS NOT (SELECT seq FROM ledger_heads WHERE org_id = NEW.org_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS commands_reversal_rules BEFORE INSERT ON commands WHEN NEW.reverses_command_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a reversal cannot be reversed')
  WHERE EXISTS (SELECT 1 FROM commands WHERE org_id = NEW.org_id AND id = NEW.reverses_command_id AND reverses_command_id IS NOT NULL);
  SELECT RAISE(ABORT, 'migrated history is not reversible in the app (counsel-approved import instead)')
  WHERE EXISTS (SELECT 1 FROM commands WHERE org_id = NEW.org_id AND id = NEW.reverses_command_id AND actor_kind = 'import');
  SELECT RAISE(ABORT, 'reverse the dependent commands first')
  WHERE EXISTS (
    SELECT 1 FROM command_dependencies d
    WHERE d.org_id = NEW.org_id AND d.depends_on_command_id = NEW.reverses_command_id
      AND NOT EXISTS (SELECT 1 FROM commands r WHERE r.org_id = d.org_id AND r.reverses_command_id = d.command_id));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS commands_append_only_update BEFORE UPDATE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS commands_append_only_delete BEFORE DELETE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS command_dependencies_not_on_reversed BEFORE INSERT ON command_dependencies
WHEN EXISTS (SELECT 1 FROM commands r WHERE r.org_id = NEW.org_id AND r.reverses_command_id = NEW.depends_on_command_id)
BEGIN SELECT RAISE(ABORT, 'cannot build on a reversed command'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS command_dependencies_append_only_update BEFORE UPDATE ON command_dependencies
BEGIN SELECT RAISE(ABORT, 'command dependencies are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS command_dependencies_append_only_delete BEFORE DELETE ON command_dependencies
BEGIN SELECT RAISE(ABORT, 'command dependencies are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS securities_append_only_update BEFORE UPDATE ON securities
BEGIN SELECT RAISE(ABORT, 'security identities are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS securities_append_only_delete BEFORE DELETE ON securities
BEGIN SELECT RAISE(ABORT, 'security identities are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuations_immutable BEFORE UPDATE ON valuations
BEGIN SELECT RAISE(ABORT, 'valuations are immutable; record an event or a new valuation'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuations_no_delete BEFORE DELETE ON valuations
BEGIN SELECT RAISE(ABORT, 'valuations are never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuation_prices_immutable_update BEFORE UPDATE ON valuation_prices
BEGIN SELECT RAISE(ABORT, 'valuation prices are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuation_prices_immutable_delete BEFORE DELETE ON valuation_prices
BEGIN SELECT RAISE(ABORT, 'valuation prices are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuation_events_reversal_target BEFORE INSERT ON valuation_events WHEN NEW.reverses_event_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM valuation_events e WHERE e.org_id = NEW.org_id AND e.id = NEW.reverses_event_id
                   AND e.kind = 'MATERIAL_EVENT' AND e.valuation_id = NEW.valuation_id)
BEGIN SELECT RAISE(ABORT, 'only a material-event flag of the same valuation can be reversed'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuation_events_append_only_update BEFORE UPDATE ON valuation_events
BEGIN SELECT RAISE(ABORT, 'valuation events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuation_events_append_only_delete BEFORE DELETE ON valuation_events
BEGIN SELECT RAISE(ABORT, 'valuation events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS transactions_sequence_and_chain BEFORE INSERT ON transactions
BEGIN
  SELECT RAISE(ABORT, 'stale ledger: seq must be head + 1')
  WHERE NEW.seq IS NOT (SELECT seq + 1 FROM ledger_heads WHERE org_id = NEW.org_id);
  SELECT RAISE(ABORT, 'broken chain: prev_hash must equal the head hash')
  WHERE NEW.prev_hash IS NOT (SELECT COALESCE(head_hash, genesis_hash) FROM ledger_heads WHERE org_id = NEW.org_id);
  SELECT RAISE(ABORT, 'seq outside the command''s declared range')
  WHERE NOT EXISTS (SELECT 1 FROM commands c WHERE c.org_id = NEW.org_id AND c.id = NEW.command_id AND NEW.seq BETWEEN c.first_seq AND c.last_seq);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS transactions_reversal_rules BEFORE INSERT ON transactions
BEGIN
  SELECT RAISE(ABORT, 'an X_REVERSAL must belong to the command that reverses its target''s command')
  WHERE NEW.reverses_tx_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM commands c JOIN transactions t ON t.org_id = c.org_id AND t.command_id = c.reverses_command_id
    WHERE c.org_id = NEW.org_id AND c.id = NEW.command_id AND t.id = NEW.reverses_tx_id);
  SELECT RAISE(ABORT, 'a reverse-command appends X_REVERSAL transactions only')
  WHERE NEW.reverses_tx_id IS NULL AND EXISTS (
    SELECT 1 FROM commands c WHERE c.org_id = NEW.org_id AND c.id = NEW.command_id AND c.reverses_command_id IS NOT NULL);
  SELECT RAISE(ABORT, 'an X_REVERSAL cannot target another reversal')
  WHERE NEW.reverses_tx_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM transactions t WHERE t.org_id = NEW.org_id AND t.id = NEW.reverses_tx_id AND t.type = 'X_REVERSAL');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS transactions_advance_head AFTER INSERT ON transactions
BEGIN
  UPDATE ledger_heads SET seq = NEW.seq, head_hash = NEW.chain_hash, updated_at = NEW.recorded_at WHERE org_id = NEW.org_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS transactions_append_only_update BEFORE UPDATE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS transactions_append_only_delete BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_collections_version BEFORE UPDATE ON document_collections WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS documents_version BEFORE UPDATE ON documents WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS documents_identity_immutable BEFORE UPDATE ON documents
WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_size IS NOT OLD.byte_size OR NEW.content_type IS NOT OLD.content_type
  OR NEW.org_id IS NOT OLD.org_id OR NEW.source IS NOT OLD.source OR NEW.created_at IS NOT OLD.created_at
  OR NEW.uploaded_by IS NOT OLD.uploaded_by OR NEW.pulley_id IS NOT OLD.pulley_id
BEGIN SELECT RAISE(ABORT, 'document bytes and identity are immutable; upload a new version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS documents_company_visibility_requires_no_holder BEFORE UPDATE OF holder_published_at ON documents
WHEN NEW.holder_published_at IS NOT NULL AND (
  SELECT COUNT(DISTINCT h) FROM (
    SELECT l.stakeholder_id AS h FROM document_links l
     WHERE l.document_id = NEW.id AND l.revoked_at IS NULL AND l.stakeholder_id IS NOT NULL
    UNION ALL
    SELECT s.stakeholder_id FROM document_links l JOIN securities s ON s.org_id = l.org_id AND s.id = l.security_id
     WHERE l.document_id = NEW.id AND l.revoked_at IS NULL
    UNION ALL
    SELECT r.stakeholder_id FROM document_links l JOIN exercise_requests r ON r.org_id = l.org_id AND r.id = l.exercise_request_id
     WHERE l.document_id = NEW.id AND l.revoked_at IS NULL)) <> 0
BEGIN SELECT RAISE(ABORT, 'company visibility requires no holder link'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are archived, never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_links_no_holder_on_company_resource BEFORE INSERT ON document_links
WHEN (SELECT holder_published_at FROM documents WHERE org_id = NEW.org_id AND id = NEW.document_id) IS NOT NULL
 AND COALESCE(NEW.stakeholder_id,
              (SELECT stakeholder_id FROM securities WHERE org_id = NEW.org_id AND id = NEW.security_id),
              (SELECT stakeholder_id FROM exercise_requests WHERE org_id = NEW.org_id AND id = NEW.exercise_request_id)) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'hide a company resource before linking it to a holder'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_links_no_delete BEFORE DELETE ON document_links
BEGIN SELECT RAISE(ABORT, 'links are revoked, never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_links_revoke_default_deny AFTER UPDATE OF revoked_at ON document_links
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE documents SET holder_visible = 0, holder_published_at = NULL, holder_published_by = NULL,
                       version = version + 1, updated_at = NEW.revoked_at
   WHERE org_id = NEW.org_id AND id = NEW.document_id AND holder_visible = 1 AND holder_published_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM document_links l WHERE l.org_id = NEW.org_id AND l.document_id = NEW.document_id
        AND l.revoked_at IS NULL AND (
          l.stakeholder_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM securities s WHERE s.org_id = l.org_id AND s.id = l.security_id)
          OR EXISTS (SELECT 1 FROM exercise_requests r WHERE r.org_id = l.org_id AND r.id = l.exercise_request_id)
        )
     );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS certificates_version BEFORE UPDATE ON certificates WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS certificates_rules BEFORE UPDATE ON certificates
BEGIN
  SELECT RAISE(ABORT, 'illegal certificate transition (ISSUED → CANCELLED or VOID only)')
  WHERE NOT (OLD.status = 'ISSUED' AND NEW.status IN ('CANCELLED', 'VOID'));
  SELECT RAISE(ABORT, 'certificate contents are immutable')
  WHERE NEW.security_id IS NOT OLD.security_id OR NEW.certificate_number IS NOT OLD.certificate_number
     OR NEW.issued_date IS NOT OLD.issued_date OR NEW.document_id IS NOT OLD.document_id
     OR NEW.signatories IS NOT OLD.signatories OR NEW.legends IS NOT OLD.legends OR NEW.org_id IS NOT OLD.org_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS certificates_no_delete BEFORE DELETE ON certificates
BEGIN SELECT RAISE(ABORT, 'certificates are never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS exercise_requests_version BEFORE UPDATE ON exercise_requests WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS exercise_requests_transition BEFORE UPDATE ON exercise_requests
BEGIN
  SELECT RAISE(ABORT, 'migrated exercise requests are immutable history') WHERE OLD.pulley_id IS NOT NULL;
  SELECT RAISE(ABORT, 'illegal exercise request transition')
  WHERE NOT (
       (OLD.status = NEW.status AND OLD.status IN ('NEEDS_REVIEW', 'AWAITING_PAYMENT'))
    OR (OLD.status = 'NEEDS_REVIEW' AND NEW.status IN ('AWAITING_PAYMENT', 'AWAITING_HOLDER_CONFIRMATION', 'REJECTED', 'CANCELLED'))
    OR (OLD.status = 'AWAITING_PAYMENT' AND NEW.status IN ('EXERCISED', 'CANCELLED', 'AWAITING_HOLDER_CONFIRMATION'))
    OR (OLD.status = 'AWAITING_HOLDER_CONFIRMATION' AND (NEW.status = 'CANCELLED'
          OR (NEW.status = 'NEEDS_REVIEW' AND OLD.decided_at IS NULL)
          OR (NEW.status = 'AWAITING_PAYMENT' AND OLD.decided_at IS NOT NULL)))
    OR (OLD.status = 'EXERCISED' AND NEW.status = 'REVERSED'));
  SELECT RAISE(ABORT, 'REVERSED needs the completing command to be reversed first')
  WHERE NEW.status = 'REVERSED' AND NOT EXISTS (
    SELECT 1 FROM commands r WHERE r.org_id = NEW.org_id AND r.reverses_command_id = NEW.completed_command_id);
  SELECT RAISE(ABORT, 'request identity is immutable')
  WHERE NEW.security_id IS NOT OLD.security_id OR NEW.stakeholder_id IS NOT OLD.stakeholder_id
     OR NEW.request_number IS NOT OLD.request_number OR NEW.org_id IS NOT OLD.org_id
     OR (OLD.completed_command_id IS NOT NULL AND NEW.completed_command_id IS NOT OLD.completed_command_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS exercise_requests_no_delete BEFORE DELETE ON exercise_requests
BEGIN SELECT RAISE(ABORT, 'exercise requests are never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS signature_requests_version BEFORE UPDATE ON signature_requests WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS signature_requests_transition BEFORE UPDATE ON signature_requests
BEGIN
  SELECT RAISE(ABORT, 'migrated signature state is immutable evidence') WHERE OLD.pulley_id IS NOT NULL;
  SELECT RAISE(ABORT, 'a signature act is final (PENDING → SIGNED, WAIVED or CANCELLED only)')
  WHERE NOT (OLD.status = 'PENDING' AND NEW.status IN ('SIGNED', 'WAIVED', 'CANCELLED'));
  SELECT RAISE(ABORT, 'signature request identity is immutable')
  WHERE NEW.security_id IS NOT OLD.security_id OR NEW.exercise_request_id IS NOT OLD.exercise_request_id
     OR NEW.signer_role IS NOT OLD.signer_role OR NEW.org_id IS NOT OLD.org_id OR NEW.created_at IS NOT OLD.created_at;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS signature_requests_no_delete BEFORE DELETE ON signature_requests
BEGIN SELECT RAISE(ABORT, 'signature requests are never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS scheduled_terminations_version BEFORE UPDATE ON scheduled_terminations WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS scheduled_terminations_transition BEFORE UPDATE ON scheduled_terminations
BEGIN
  SELECT RAISE(ABORT, 'illegal scheduled termination transition (SCHEDULED → APPLIED or CANCELLED only)')
  WHERE NOT (OLD.status = 'SCHEDULED' AND NEW.status IN ('APPLIED', 'CANCELLED'));
  SELECT RAISE(ABORT, 'scheduled termination contents are immutable')
  WHERE NEW.stakeholder_id IS NOT OLD.stakeholder_id OR NEW.termination_date IS NOT OLD.termination_date
     OR NEW.termination_type IS NOT OLD.termination_type OR NEW.vesting_stop_date IS NOT OLD.vesting_stop_date
     OR NEW.request IS NOT OLD.request OR NEW.request_sha256 IS NOT OLD.request_sha256;
  SELECT RAISE(ABORT, 'a scheduled termination is applied by a terminate-stakeholder command')
  WHERE NEW.status = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM commands c WHERE c.org_id = NEW.org_id AND c.id = NEW.applied_command_id AND c.type = 'terminate-stakeholder');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS scheduled_terminations_no_delete BEFORE DELETE ON scheduled_terminations
BEGIN SELECT RAISE(ABORT, 'scheduled terminations are never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS election_83b_append_only_update BEFORE UPDATE ON election_83b_records
BEGIN SELECT RAISE(ABORT, '83(b) records are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS election_83b_append_only_delete BEFORE DELETE ON election_83b_records
BEGIN SELECT RAISE(ABORT, '83(b) records are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS payment_instructions_version BEFORE UPDATE ON payment_instructions WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'stale version'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS payment_instructions_no_delete BEFORE DELETE ON payment_instructions
BEGIN SELECT RAISE(ABORT, 'payment instructions are never deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stakeholders_merge_pointer BEFORE UPDATE OF merged_into_id ON stakeholders
WHEN NEW.merged_into_id IS NOT NULL AND (
  NEW.merged_into_id = NEW.id OR NOT EXISTS (
    SELECT 1 FROM stakeholders survivor WHERE survivor.org_id = NEW.org_id AND survivor.id = NEW.merged_into_id
  )
)
BEGIN SELECT RAISE(ABORT, 'a stakeholder merge must name another record in the same org'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stakeholder_emails_rules BEFORE UPDATE ON stakeholder_emails
BEGIN
  SELECT RAISE(ABORT, 'a removed e-mail cannot change') WHERE OLD.removed_at IS NOT NULL;
  SELECT RAISE(ABORT, 'remove the e-mail and add a new one instead of editing it')
  WHERE NEW.email IS NOT OLD.email OR NEW.kind IS NOT OLD.kind OR NEW.org_id IS NOT OLD.org_id
     OR (NEW.stakeholder_id IS NOT OLD.stakeholder_id AND NOT EXISTS (
       SELECT 1 FROM stakeholders s WHERE s.org_id = OLD.org_id
         AND s.id = OLD.stakeholder_id AND s.merged_into_id = NEW.stakeholder_id
     ));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_links_rules BEFORE UPDATE ON document_links
BEGIN
  SELECT RAISE(ABORT, 'a revoked link cannot change') WHERE OLD.revoked_at IS NOT NULL;
  SELECT RAISE(ABORT, 'links are immutable; only a one-time revocation is allowed')
  WHERE NEW.document_id IS NOT OLD.document_id OR NEW.role IS NOT OLD.role OR NEW.org_id IS NOT OLD.org_id
     OR NEW.security_id IS NOT OLD.security_id
     OR (NEW.stakeholder_id IS NOT OLD.stakeholder_id AND NOT EXISTS (
       SELECT 1 FROM stakeholders s
        WHERE s.org_id = OLD.org_id AND ((s.id = OLD.stakeholder_id AND s.merged_into_id = NEW.stakeholder_id)
          OR (s.id = NEW.stakeholder_id AND s.merged_into_id = OLD.stakeholder_id))
     ))
     OR (NEW.stakeholder_id IS NOT OLD.stakeholder_id AND (
       NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_by IS NOT OLD.revoked_by OR NEW.revoke_reason IS NOT OLD.revoke_reason
     ))
     OR NEW.stock_plan_id IS NOT OLD.stock_plan_id OR NEW.stock_class_id IS NOT OLD.stock_class_id
     OR NEW.valuation_id IS NOT OLD.valuation_id OR NEW.exercise_request_id IS NOT OLD.exercise_request_id
     OR NEW.transaction_id IS NOT OLD.transaction_id
     OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS documents_holder_visible_single_holder BEFORE UPDATE OF holder_visible ON documents
WHEN NEW.holder_visible = 1 AND (
  SELECT COUNT(DISTINCT COALESCE(st.merged_into_id, h.holder_id)) FROM (
    SELECT l.stakeholder_id AS holder_id FROM document_links l
     WHERE l.document_id = NEW.id AND l.revoked_at IS NULL AND l.stakeholder_id IS NOT NULL
    UNION ALL
    SELECT s.stakeholder_id FROM document_links l JOIN securities s ON s.org_id = l.org_id AND s.id = l.security_id
     WHERE l.document_id = NEW.id AND l.revoked_at IS NULL
    UNION ALL
    SELECT r.stakeholder_id FROM document_links l JOIN exercise_requests r ON r.org_id = l.org_id AND r.id = l.exercise_request_id
     WHERE l.document_id = NEW.id AND l.revoked_at IS NULL
  ) h LEFT JOIN stakeholders st ON st.org_id = NEW.org_id AND st.id = h.holder_id
) > 1
BEGIN SELECT RAISE(ABORT, 'a document linked to several holders cannot be visible to holders'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_links_visible_single_holder BEFORE INSERT ON document_links
WHEN (SELECT holder_visible FROM documents WHERE org_id = NEW.org_id AND id = NEW.document_id) = 1 AND (
  SELECT COUNT(DISTINCT COALESCE(st.merged_into_id, h.holder_id)) FROM (
    SELECT COALESCE(NEW.stakeholder_id,
                    (SELECT stakeholder_id FROM securities WHERE org_id = NEW.org_id AND id = NEW.security_id),
                    (SELECT stakeholder_id FROM exercise_requests WHERE org_id = NEW.org_id AND id = NEW.exercise_request_id)) AS holder_id
    UNION ALL
    SELECT l.stakeholder_id FROM document_links l
     WHERE l.document_id = NEW.document_id AND l.revoked_at IS NULL AND l.stakeholder_id IS NOT NULL
    UNION ALL
    SELECT s.stakeholder_id FROM document_links l JOIN securities s ON s.org_id = l.org_id AND s.id = l.security_id
     WHERE l.document_id = NEW.document_id AND l.revoked_at IS NULL
    UNION ALL
    SELECT r.stakeholder_id FROM document_links l JOIN exercise_requests r ON r.org_id = l.org_id AND r.id = l.exercise_request_id
     WHERE l.document_id = NEW.document_id AND l.revoked_at IS NULL
  ) h LEFT JOIN stakeholders st ON st.org_id = NEW.org_id AND st.id = h.holder_id
) > 1
BEGIN SELECT RAISE(ABORT, 'a holder-visible document cannot be linked to a second holder'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_blobs_append_only_update BEFORE UPDATE ON document_blobs
BEGIN SELECT RAISE(ABORT, 'document blobs are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_blobs_append_only_delete BEFORE DELETE ON document_blobs
BEGIN SELECT RAISE(ABORT, 'document blobs are append-only'); END;
