/**
 * The roles and fields an envelope is signed with: its own, `envelopes.roles_json` and `fields_json`, set when it is
 * sent, from its template (byte for byte) or with its own uploaded document; never read from a template while it is
 * signed, so a template changing afterwards changes nothing for its signers. SQL for a query with the envelope aliased
 * `e`; the JSON is as stored (signature records hash it).
 */
export const ENVELOPE_ROLES = 'e.roles_json';
export const ENVELOPE_FIELDS = 'e.fields_json';
