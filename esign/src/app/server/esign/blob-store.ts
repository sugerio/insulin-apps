/**
 * Object storage on D1. An Insulin app gets one D1 database and static assets, nothing else, so the
 * PDFs, field images, seals and delivery PDFs E-sign used to keep in R2 live in two tables:
 * `blob_chunks` holds an upload's bytes in 256 KiB chunks, and `blobs` names the upload a key points
 * to. The interface is the part of R2's `R2Bucket` E-sign uses (get, head, put with
 * `onlyIf: { etagDoesNotMatch: '*' }`, delete, list by prefix), so the signing code is unchanged.
 *
 * A put writes its chunks under a fresh upload id first, then points the key at them in one
 * statement, so a reader sees a whole object or none. A put that may not overwrite (`onlyIf`) loses a
 * race cleanly: its pointer insert does nothing, it deletes its own chunks and answers null, as R2
 * does. An overwritten upload's chunks are deleted after the pointer moved.
 */
export const BLOB_CHUNK_BYTES = 256 * 1024;
const CHUNKS_PER_BATCH = 2;

export interface BlobInfo {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}

export interface BlobObject extends BlobInfo {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface BlobPutOptions {
  /** `{ etagDoesNotMatch: '*' }`: only when the key holds nothing yet (R2's create-only put). */
  onlyIf?: { etagDoesNotMatch?: string };
  httpMetadata?: { contentType?: string };
}

/** The R2Bucket subset E-sign stores its objects with. */
export interface BlobStore {
  get(key: string): Promise<BlobObject | null>;
  head(key: string): Promise<BlobInfo | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: BlobPutOptions): Promise<BlobInfo | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: BlobInfo[]; truncated: boolean }>;
}

type BlobRow = { key: string; upload_id: string; size: number; content_type: string | null; created_at: number };

const bytesOf = (value: ArrayBuffer | ArrayBufferView | string): Uint8Array => {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
};

const info = (row: BlobRow): BlobInfo => ({
  key: row.key,
  size: row.size,
  uploaded: new Date(row.created_at),
  ...(row.content_type ? { httpMetadata: { contentType: row.content_type } } : {}),
});

/** One logical bucket (`artifacts`, or the local preview's `test-mail`) in the app's D1 database. */
export class D1BlobStore implements BlobStore {
  private readonly db: D1Database;
  private readonly bucket: string;

  constructor(db: D1Database, bucket = 'artifacts') {
    this.db = db;
    this.bucket = bucket;
  }

  private async row(key: string): Promise<BlobRow | null> {
    return this.db.prepare('SELECT key, upload_id, size, content_type, created_at FROM blobs WHERE bucket = ? AND key = ?')
      .bind(this.bucket, key).first<BlobRow>();
  }

  private async bytes(row: BlobRow): Promise<Uint8Array> {
    const { results } = await this.db.prepare('SELECT bytes FROM blob_chunks WHERE upload_id = ? ORDER BY chunk_index')
      .bind(row.upload_id).all<{ bytes: ArrayBuffer | Uint8Array | number[] }>();
    const out = new Uint8Array(row.size);
    let offset = 0;
    for (const { bytes } of results) {
      const chunk = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes);
      if (offset + chunk.byteLength > row.size) throw new Error('Stored object is longer than recorded');
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== row.size) throw new Error('Stored object is incomplete');
    return out;
  }

  async head(key: string): Promise<BlobInfo | null> {
    const row = await this.row(key);
    return row ? info(row) : null;
  }

  async get(key: string): Promise<BlobObject | null> {
    const row = await this.row(key);
    if (!row) return null;
    const bytes = await this.bytes(row);
    return {
      ...info(row),
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    };
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options: BlobPutOptions = {}): Promise<BlobInfo | null> {
    const createOnly = options.onlyIf?.etagDoesNotMatch === '*';
    if (createOnly && await this.row(key)) return null;
    const bytes = bytesOf(value);
    const uploadId = crypto.randomUUID();
    const now = Date.now();
    for (let start = 0, index = 0; start < bytes.byteLength || index === 0; start += BLOB_CHUNK_BYTES * CHUNKS_PER_BATCH) {
      const statements: D1PreparedStatement[] = [];
      for (let offset = start; statements.length < CHUNKS_PER_BATCH && (offset < bytes.byteLength || index === 0); offset += BLOB_CHUNK_BYTES) {
        statements.push(this.db.prepare('INSERT INTO blob_chunks (upload_id, chunk_index, bytes) VALUES (?, ?, ?)')
          .bind(uploadId, index, bytes.slice(offset, offset + BLOB_CHUNK_BYTES)));
        index += 1;
      }
      await this.db.batch(statements);
    }
    const contentType = options.httpMetadata?.contentType ?? null;
    const previous = createOnly ? null : await this.row(key);
    const pointed = await this.db.prepare(createOnly
      ? 'INSERT INTO blobs (bucket, key, upload_id, size, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (bucket, key) DO NOTHING'
      : `INSERT INTO blobs (bucket, key, upload_id, size, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bucket, key) DO UPDATE SET upload_id = excluded.upload_id, size = excluded.size,
           content_type = excluded.content_type, created_at = excluded.created_at`,
    ).bind(this.bucket, key, uploadId, bytes.byteLength, contentType, now).run();
    if (pointed.meta.changes !== 1) {
      await this.db.prepare('DELETE FROM blob_chunks WHERE upload_id = ?').bind(uploadId).run();
      return null;
    }
    if (previous && previous.upload_id !== uploadId) {
      await this.db.prepare('DELETE FROM blob_chunks WHERE upload_id = ? AND NOT EXISTS (SELECT 1 FROM blobs WHERE upload_id = ?)')
        .bind(previous.upload_id, previous.upload_id).run();
    }
    return { key, size: bytes.byteLength, uploaded: new Date(now), ...(contentType ? { httpMetadata: { contentType } } : {}) };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const row = await this.row(key);
      if (!row) continue;
      await this.db.batch([
        this.db.prepare('DELETE FROM blobs WHERE bucket = ? AND key = ? AND upload_id = ?').bind(this.bucket, key, row.upload_id),
        this.db.prepare('DELETE FROM blob_chunks WHERE upload_id = ? AND NOT EXISTS (SELECT 1 FROM blobs WHERE upload_id = ?)').bind(row.upload_id, row.upload_id),
      ]);
    }
  }

  async list(options: { prefix?: string; limit?: number } = {}): Promise<{ objects: BlobInfo[]; truncated: boolean }> {
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
    const prefix = options.prefix ?? '';
    const { results } = await this.db.prepare(
      `SELECT key, upload_id, size, content_type, created_at FROM blobs
       WHERE bucket = ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?`,
    ).bind(this.bucket, prefix.length, prefix, limit + 1).all<BlobRow>();
    return { objects: results.slice(0, limit).map(info), truncated: results.length > limit };
  }
}
