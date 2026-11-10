// "About signing": the recipient's help on the signing page, in plain words. It describes only what the page does;
// the members' Docs topic "What signers see and do" says the same at more length (pages/docs/signers.ts).
import React from 'react';

const h = React.createElement;

export function SigningHelp({ sender, documentName }: { sender: string; documentName?: string }) {
  const doc = documentName || 'the document';
  return h('div', { className: 'esign-help' },
    h('p', null, `${sender} asked you to sign ${doc}. Signing takes three steps.`),
    h('ul', null,
      h('li', null, h('strong', null, 'Review. '), 'Read the document. Its fingerprint (SHA-256) identifies exactly this file, and you can download a copy.'),
      h('li', null, h('strong', null, "Confirm it's you. "), 'We email a 6-digit code to your address. It works for 10 minutes; you can ask for a new one after a minute.'),
      h('li', null, h('strong', null, 'Sign. '), 'Type your full name to adopt your signature, check how it looks, and agree to sign electronically.')),
    h('p', null, 'If you don\'t want to sign, choose Decline to sign on the first step and give a reason. You confirm it\'s you with the emailed code first. The sender is told, and nobody can sign this document afterwards.'),
    h('p', null, 'When everyone has signed, you get an email with a link to download the signed document and its certificate of completion. The link works once, within 30 days.'),
    h('p', null, 'Each step is recorded in the document\'s audit trail, with the time, your IP address and your browser.'));
}
