/**
 * The consent to use electronic records and signatures that a signer agrees to before signing
 * (ESIGN Act / UETA). The signing page shows exactly this text; the signature's audit event
 * records its version and SHA-256. Change the version whenever the text changes.
 * DRAFT wording: to be reviewed by counsel before production use.
 */
export const CONSENT_DISCLOSURE = {
  version: '2026-11-07',
  text: [
    'Consent to use electronic records and signatures',
    'By checking the box below and selecting Sign document, you agree that:',
    '- you are signing this document electronically, and your electronic signature has the same effect as your handwritten signature;',
    '- you consent to receive this document and the records of this signing electronically.',
    'You may ask the sender for a paper copy, or withdraw this consent, by contacting the sender before you sign; withdrawing it ends this electronic signing. There is no charge for this.',
    'After all parties have signed, you will receive the signed document and its certificate of completion by email.',
    'To view and keep these records you need a current web browser, a PDF reader, and access to your email.',
  ].join('\n'),
} as const;

export async function consentDisclosure(): Promise<{ version: string; text: string; sha256: string }> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CONSENT_DISCLOSURE.text));
  return { ...CONSENT_DISCLOSURE, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') };
}
