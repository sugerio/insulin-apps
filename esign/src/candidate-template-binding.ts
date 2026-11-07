// Legacy envelopes have no candidate source or snapshot; candidate-bound envelopes require both.
export const candidateTemplateBinding = `(
 (NOT EXISTS (SELECT 1 FROM candidate_envelope_sources cs WHERE cs.envelope_id=e.id)
  AND NOT EXISTS (SELECT 1 FROM candidate_template_snapshots ct WHERE ct.envelope_id=e.id))
 OR EXISTS (SELECT 1 FROM candidate_envelope_sources cs JOIN candidate_template_snapshots ct ON ct.envelope_id=cs.envelope_id
  WHERE cs.envelope_id=e.id AND ct.roles_json=p.roles_json AND ct.fields_json=p.fields_json)
)`;
