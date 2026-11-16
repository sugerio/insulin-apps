import { envelopeDetails } from './details.ts';

/**
 * The file name a completed envelope's signed PDF (with its certificate) is saved under, for the sender's download and
 * each signer's copy alike: its document's name and the day it was completed (UTC), as in
 * "Reseller Agreement - Signed 2026-11-13.pdf"; "(local test)" for a locally sealed one. Without a document name, the
 * envelope's short id names it. Characters no file system takes are dropped.
 */
export function signedFileName(documentName: string | undefined, completedAt: number, envelopeId: string, localTest = false): string {
  const name = (documentName ?? '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120).trim();
  const day = Number.isFinite(completedAt) ? new Date(completedAt).toISOString().slice(0, 10) : '';
  return `${name || `Envelope ${envelopeId.slice(0, 8)}`} - Signed${day ? ` ${day}` : ''}${localTest ? ' (local test)' : ''}.pdf`;
}

/** The name of a completed envelope's signed PDF, from its document name and its completion in the audit trail. */
export async function signedFileNameOf(db: D1Database, envelopeId: string, localTest = false): Promise<string> {
  const row = await db.prepare(`SELECT e.details_json, e.created_at,
      (SELECT MAX(a.occurred_at) FROM audit_events a WHERE a.envelope_id = e.id AND a.type = 'COMPLETED') AS completed_at
      FROM envelopes e WHERE e.id = ?`).bind(envelopeId).first<{ details_json: string | null; created_at: number; completed_at: number | null }>();
  return signedFileName(envelopeDetails(row?.details_json).documentName, row?.completed_at ?? row?.created_at ?? Number.NaN, envelopeId, localTest);
}

/** A Content-Disposition naming the file: an ASCII `filename` for old clients and the exact name as `filename*` (RFC 6266). */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
