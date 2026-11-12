import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { finalizeLocalTestEvidence } from './seal/local.ts';
import type { SealedIdentity } from './seal/evidence.ts';
import { AUDIT, auditTrail, type AuditEvent } from './audit.ts';
import { describeHostAuthentication, parseHostAuthentication, sendFacts, versionedName } from './signer-facts.ts';
import { envelopeDetails } from './details.ts';
import type { BlobStore } from './blob-store.ts';

const hash = async (bytes: Uint8Array | ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes instanceof Uint8Array ? Uint8Array.from(bytes) : bytes)), n => n.toString(16).padStart(2, '0')).join('');

/** How a signer was identified, from their OTP_VERIFIED event: the host's sign-in, then the emailed code. */
export function identification(detail: Record<string, unknown> | null | undefined): string {
  // Opened with the invitation Esign emailed them.
  if (detail?.entry === 'EMAIL_INVITATION') return 'Email invitation link; email one-time code';
  const auth = parseHostAuthentication(detail?.hostAuthentication);
  // The account the host said was signed in, which Esign checked has the signer's email.
  const signedIn = typeof detail?.signedInEmail === 'string' && detail.signedInEmail ? detail.signedInEmail : '';
  if (signedIn) return `${auth && auth !== 'invalid' ? `${describeHostAuthentication(auth)}; ` : ''}signed in to the sender's system as ${signedIn}; email one-time code`;
  return auth && auth !== 'invalid' ? `${describeHostAuthentication(auth)}; email one-time code` : 'Email one-time code';
}

/** The signer's title and company on a SIGNED event ("" for older signatures, which had none). */
export function authorityFact(detail: Record<string, unknown> | null | undefined): string {
  const title = typeof detail?.title === 'string' ? detail.title : '', company = typeof detail?.onBehalfOf === 'string' ? detail.onBehalfOf : '';
  if (!title && !company) return '';
  return [title ? `as ${title}` : '', company ? `on behalf of ${company}${detail?.authorityConfirmed === true ? ' (authority confirmed)' : ''}` : ''].filter(Boolean).join(', ');
}

/** The authority fact of a signer's own SIGNED event ("" when they signed for nobody, or for an older signature). */
export function signerAuthority(events: readonly AuditEvent[], taskId: string | undefined): string {
  if (!taskId) return '';
  return authorityFact(events.find(event => event.taskId === taskId && event.type === AUDIT.signed)?.detail);
}

const BROWSERS: [RegExp, string][] = [[/Edg(?:A|iOS)?\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'], [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'], [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'Safari']];

/** A browser's user agent as people say it ("Chrome 141 on macOS"); the string itself, shortened, when it isn't a known browser. */
export function describeDevice(userAgent: string): string {
  const browser = BROWSERS.map(([pattern, name]) => { const match = pattern.exec(userAgent); return match ? `${name} ${match[1]}` : ''; }).find(Boolean);
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)_/.exec(userAgent), android = /Android (\d+)/.exec(userAgent);
  const os = ios ? `iOS ${ios[1]}` : android ? `Android ${android[1]}` : /Windows NT/.test(userAgent) ? 'Windows'
    : /Mac OS X/.test(userAgent) ? 'macOS' : /CrOS/.test(userAgent) ? 'ChromeOS' : /Linux/.test(userAgent) ? 'Linux' : '';
  if (!browser) return userAgent.length > 80 ? `${userAgent.slice(0, 79)}...` : userAgent;
  return os ? `${browser} on ${os}` : browser;
}

/** A time on the certificate: UTC to the second ("2026-11-11 08:12:39"); the headings say UTC. */
const utc = (at: number) => new Date(at).toISOString().slice(0, 19).replace('T', ' ');
// The standard PDF font only has Latin-1; keep every recorded string to printable ASCII.
const ascii = (value: string) => value.replace(/[^\x20-\x7e]/g, '?');

type DeliveryRow = { id: string; task_id?: string; sequence: number; recipient_name: string; otp_verified_at: number; consented_at: number; object_key: string };
/** The managed seal, as the delivery PDF names it. */
export type DeliverySeal = { keyId: string; timestampTime: number; tsaUrl: string };
/**
 * Verified evidence for the delivery PDF, and how its certificate pages describe the seal: `mark`
 * goes in every certificate page's footer, `notes` after the seal.
 */
export type DeliveryEvidence = {
  verify(): Promise<{ source: { id: string; sha256: string }; signatures: DeliveryRow[]; identities?: SealedIdentity[]; finalSha256: string; seal?: DeliverySeal; audit?: { sealed: AuditEvent[]; afterSeal: AuditEvent[] } } | void>;
  mark: string; notes: string[]; name: string; format: string;
};
const localDelivery = (db: D1Database, bucket: BlobStore, tenantId: string, envelopeId: string, key: Uint8Array): DeliveryEvidence => ({
  verify: () => finalizeLocalTestEvidence(db, bucket, tenantId, envelopeId, key, true),
  mark: 'LOCAL TEST ONLY',
  notes: ['LOCAL TEST ONLY - Local simulation; not a legal guarantee or independent timestamp.', 'Local HMAC uses a test key, not E-sign\'s seal key or an independent TSA.', 'The original local evidence manifest does not seal this delivery PDF.'],
  name: 'local-delivery-v4', format: 'esign-local-delivery-v4',
});

/**
 * The events the certificate lists, in plain words, with who did each and from where. Each
 * signer's first opening and first look at the document, and their final page count, stand for
 * the repeats; codes sent are left out (confirming one is what counts).
 */
function eventRows(events: readonly AuditEvent[], nameOf: (taskId: string | null) => string): { at: number; what: string; by: string; ip: string }[] {
  const firstOf = new Map<string, number>(), lastViews = new Map<string, number>(), pagesSeen = new Map<string, Set<number>>();
  for (const event of events) {
    const key = `${event.type}:${event.taskId}`;
    if (!firstOf.has(key)) firstOf.set(key, event.id);
    if (event.type === AUDIT.pagesViewed && event.taskId) {
      const seen = pagesSeen.get(event.taskId) ?? new Set<number>();
      for (const page of Array.isArray(event.detail?.pages) ? event.detail.pages as unknown[] : []) if (Number.isSafeInteger(page)) seen.add(page as number);
      pagesSeen.set(event.taskId, seen); lastViews.set(event.taskId, event.id);
    }
  }
  const first = (event: AuditEvent) => firstOf.get(`${event.type}:${event.taskId}`) === event.id;
  const rows: { at: number; what: string; by: string; ip: string }[] = [];
  for (const event of events) {
    const who = nameOf(event.taskId), row = (what: string, by = who) => rows.push({ at: event.occurredAt, what, by, ip: event.ip ?? '' });
    switch (event.type) {
      // The link is issued by the sender (a member, or the host product's server): the IP is theirs.
      case AUDIT.viewIssued: if (first(event)) row(`Signing link issued to ${who}`, 'Sender'); break;
      case AUDIT.sessionOpened: if (first(event)) row('Opened the document'); break;
      // Esign emailed the signer their invitation (again, when the sender resent it).
      case AUDIT.invitationSent: row(event.detail?.resend === true ? `Invitation emailed again to ${who}` : `Invitation emailed to ${who}`, 'Esign'); break;
      case AUDIT.invitationOpened: if (first(event)) row('Opened the invitation link'); break;
      case AUDIT.documentViewed: if (first(event)) row('Viewed the document'); break;
      case AUDIT.pagesViewed: if (event.taskId && lastViews.get(event.taskId) === event.id) {
        const total = Number(event.detail?.total);
        row(`Viewed ${pagesSeen.get(event.taskId)?.size ?? 0}${Number.isSafeInteger(total) ? ` of ${total}` : ''} pages`);
      } break;
      case AUDIT.otpVerified: row('Confirmed the emailed code'); break;
      case AUDIT.signed: row('Signed'); break;
      case AUDIT.declined: row('Declined'); break;
    }
  }
  return rows;
}

export async function deliveryPdf(db: D1Database, bucket: BlobStore, tenantId: string, envelopeId: string, source: Uint8Array | DeliveryEvidence) {
  const described = source instanceof Uint8Array ? localDelivery(db, bucket, tenantId, envelopeId, source) : source;
  const evidence = await described.verify();
  if (!evidence) throw new Error('Evidence unavailable');
  const last = evidence.signatures[evidence.signatures.length - 1];
  const input = await bucket.get(last.object_key);
  if (!input) throw new Error('Final PDF missing');
  const inputBytes = await input.arrayBuffer();
  if (await hash(inputBytes) !== evidence.finalSha256) throw new Error('Final PDF mismatch');
  const pdf = await PDFDocument.load(inputBytes, { updateMetadata: false, throwOnInvalidObject: true });
  const documentPages = pdf.getPageCount();

  // Everything on these pages is fixed by the time the envelope completes, so a stored delivery PDF
  // is rebuilt byte for byte: the sealed events (or, for the local seal, those up to the last
  // signature), and facts set when the envelope was created.
  const facts = await sendFacts(db, envelopeId);
  const created = await db.prepare('SELECT created_at,details_json FROM envelopes WHERE id = ?').bind(envelopeId).first<{ created_at: number; details_json: string }>();
  const details = envelopeDetails(created?.details_json);
  const events = evidence.audit ? evidence.audit.sealed : await (async () => {
    const trail = await auditTrail(db, envelopeId);
    const lastSigned = Math.max(0, ...trail.filter(event => event.type === AUDIT.signed).map(event => event.id));
    return trail.filter(event => event.id <= lastSigned);
  })();
  const names = new Map(evidence.signatures.map(row => [row.task_id, row.recipient_name]));
  const nameOf = (taskId: string | null) => (taskId ? names.get(taskId) : undefined) ?? '';

  const font: PDFFont = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.16, 0.22), muted = rgb(0.40, 0.44, 0.50), rule = rgb(0.80, 0.82, 0.85);
  const LEFT = 50, RIGHT = 562, BOTTOM = 60, VALUE_X = 180, VALUE_WIDTH = RIGHT - VALUE_X;
  const pages: PDFPage[] = [];
  let page!: PDFPage; let y = 0;
  function newPage() {
    page = pdf.addPage([612, 792]); pages.push(page);
    if (pages.length > 1) page.drawText('Certificate of completion (continued)', { x: LEFT, y: 750, size: 9, font, color: muted });
    y = pages.length > 1 ? 725 : 742;
  }
  function ensure(height: number) { if (y - height < BOTTOM) newPage(); }
  /** Lines of at most `width`, broken between words; a word wider than a line is broken where it must be. */
  function wrapLines(value: string, width: number, size = 10, face = font) {
    const fits = (text: string) => face.widthOfTextAtSize(text, size) <= width;
    const lines: string[] = []; let line = '';
    for (const word of value.split(/ +/)) {
      const joined = line ? `${line} ${word}` : word;
      if (fits(joined)) { line = joined; continue; }
      if (line) lines.push(line);
      line = '';
      for (const ch of word) {
        if (line && !fits(line + ch)) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    if (line || !lines.length) lines.push(line);
    return lines;
  }
  function wrapped(value: string, x: number, width: number, size = 10, face = font, color = ink, leading = size + 5) {
    for (const part of wrapLines(value, width, size, face)) { ensure(leading); page.drawText(part, { x, y, size, font: face, color }); y -= leading; }
  }
  /** A section heading, on the same page as the first `following` points of its section. */
  function heading(value: string, following: number) { ensure(34 + following); y -= 12; page.drawText(value, { x: LEFT, y, size: 12, font: bold, color: ink }); y -= 6; page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 0.5, color: rule }); y -= 16; }
  const fieldHeight = (rows: [string, string][]) => rows.reduce((sum, [, value]) => sum + wrapLines(value, VALUE_WIDTH).length * 14 + 2, 0);
  /** Label and value rows, kept together on one page when they fit on one. */
  function fields(rows: [string, string][]) {
    const height = fieldHeight(rows);
    if (height <= 792 - 2 * BOTTOM - 80) ensure(height);
    for (const [label, value] of rows) {
      ensure(14); const top = y;
      page.drawText(label, { x: LEFT, y, size: 10, font, color: muted });
      wrapped(value, VALUE_X, VALUE_WIDTH, 10, font, ink, 14); if (y === top) y -= 14;
      y -= 2;
    }
  }

  /** A heading and its groups of rows, each group kept together on a page when it fits on one. */
  function section(title: string, groups: [string, string][][]) {
    heading(title, groups.length ? Math.min(fieldHeight(groups[0]), 300) : 0);
    groups.forEach((rows, i) => { if (i) y -= 8; fields(rows); });
  }

  newPage();
  page.drawText('Certificate of completion', { x: LEFT, y, size: 20, font: bold, color: ink }); y -= 20;
  page.drawText(`Envelope ${envelopeId}`, { x: LEFT, y, size: 10, font, color: muted }); y -= 10;
  page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 1.5, color: ink }); y -= 4;

  const documentName = versionedName(details.documentName, details.documentVersion);
  const sender = facts.sender;
  section('Document', [[
    ...(documentName ? [['Name', ascii(documentName)] as [string, string]] : []),
    ['Pages', String(documentPages)],
    ...(sender ? [['Sent by', ascii(`${sender.name}${sender.email ? ` (${sender.email})` : ''}${sender.organization ? `, ${sender.organization}` : ''}`)] as [string, string]] : []),
    ['Status', evidence.seal ? `Completed and sealed ${utc(evidence.seal.timestampTime)} UTC (RFC 3161 timestamp)` : `Completed; last signature ${utc(last.consented_at)} UTC`],
    ...(evidence.seal ? [['Timestamp authority', ascii(evidence.seal.tsaUrl)], ['Seal key SHA-256', evidence.seal.keyId]] as [string, string][] : []),
    ['Original SHA-256', evidence.source.sha256],
    ['Signed SHA-256', evidence.finalSha256],
  ]]);

  section('Signers', evidence.signatures.map(row => {
    const own = (type: string) => events.find(event => event.taskId === row.task_id && event.type === type);
    const identity = evidence.identities?.find(item => item.signatureId === row.id);
    const signed = own(AUDIT.signed);
    const named = row.task_id ? facts.namedBy.get(row.task_id) : undefined;
    const authority = ascii(authorityFact(signed?.detail));
    const device = [signed?.ip ?? '', signed?.userAgent ? ascii(describeDevice(signed.userAgent)) : ''].filter(Boolean).join(' - ');
    return [
      [`Signer ${row.sequence}`, ascii(row.recipient_name)],
      ...(identity ? [['Email', ascii(identity.email)] as [string, string]] : []),
      ...(authority ? [['Signed', authority] as [string, string]] : []),
      ...(named ? [['Named by', ascii(named)] as [string, string]] : []),
      ['Identified by', ascii(identification(own(AUDIT.otpVerified)?.detail))],
      ...(identity?.disclosure ? [['Consent', ascii(`Agreed to the electronic records disclosure, version ${identity.disclosure.version}`)] as [string, string]] : []),
      ...(device ? [['IP / device', device] as [string, string]] : []),
    ];
  }));

  heading('Events (UTC)', 40);
  const columns = [{ title: 'Time', x: LEFT, width: 88 }, { title: 'Event', x: 144, width: 156 }, { title: 'By', x: 306, width: 100 }, { title: 'IP address', x: 412, width: RIGHT - 412 }];
  const SIZE = 9, LEADING = 12;
  function tableRow(cells: string[], face: PDFFont) {
    const lines = cells.map((cell, i) => wrapLines(cell, columns[i].width, SIZE, face));
    const height = Math.max(...lines.map(cell => cell.length)) * LEADING + 4;
    if (y - height < BOTTOM) { newPage(); if (face !== bold) tableRow(columns.map(column => column.title), bold); }
    lines.forEach((cell, i) => cell.forEach((line, n) => page.drawText(line, { x: columns[i].x, y: y - n * LEADING, size: SIZE, font: face, color: face === bold ? muted : ink })));
    y -= height;
  }
  tableRow(columns.map(column => column.title), bold);
  if (created) tableRow([utc(created.created_at), 'Sent for signature', sender ? ascii(sender.name) : 'Sender', ''], font);
  const rows = eventRows(events, nameOf);
  for (const event of rows) tableRow([utc(event.at), ascii(event.what), ascii(event.by), ascii(event.ip)], font);
  if (evidence.seal) tableRow([utc(evidence.seal.timestampTime), 'Sealed and completed', 'E-sign', ''], font);
  if (rows.some(row => row.by === 'Sender')) wrapped('A signing link is issued by the sender (a member, or the host product\'s server); its IP address is theirs, not the signer\'s.', LEFT, RIGHT - LEFT, 8, font, muted, 11);

  y -= 6;
  for (const note of described.notes) { wrapped(note, LEFT, RIGHT - LEFT, 8, font, muted, 11); y -= 3; }

  // Each certificate page's footer: how it was sealed, the envelope, and the page.
  pages.forEach((certificatePage, i) => {
    certificatePage.drawLine({ start: { x: LEFT, y: 46 }, end: { x: RIGHT, y: 46 }, thickness: 0.5, color: rule });
    certificatePage.drawText(`${described.mark} - Envelope ${envelopeId}`, { x: LEFT, y: 34, size: 8, font, color: muted });
    const number = `Certificate page ${i + 1} of ${pages.length}`;
    certificatePage.drawText(number, { x: RIGHT - font.widthOfTextAtSize(number, 8), y: 34, size: 8, font, color: muted });
  });

  const bytes = await pdf.save({ useObjectStreams: false });
  const sha256 = await hash(bytes), objectKey = `envelopes/${envelopeId}/${described.name}.pdf`, metadataKey = `envelopes/${envelopeId}/${described.name}.json`;
  const metadata = { format: described.format, envelopeId, finalSha256: evidence.finalSha256, sha256 };
  const metaBytes = new TextEncoder().encode(JSON.stringify(metadata));
  async function putChecked(objectKey: string, data: Uint8Array, contentType: string) {
    const stored = await bucket.put(objectKey, data, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType } });
    if (!stored) { const existing = await bucket.get(objectKey); if (!existing || await hash(await existing.arrayBuffer()) !== await hash(data)) throw new Error('Delivery conflict'); }
  }
  await putChecked(objectKey, bytes, 'application/pdf');
  await putChecked(metadataKey, metaBytes, 'application/json');
  return { bytes, metadata };
}
