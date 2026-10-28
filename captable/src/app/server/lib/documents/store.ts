export const DOCUMENT_CHUNK_BYTES = 256 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const CHUNKS_PER_WRITE_BATCH = 2;

export class DocumentTooLargeError extends Error {
  override name = "DocumentTooLargeError";
  constructor() { super("Documents cannot exceed 10 MiB"); }
}

/** Immutable document bytes stored in D1. There is deliberately no destructive delete operation. */
export class DocumentStore {
  constructor(private readonly db: D1Database) {}

  private async writeChunks(
    table: "document_blobs" | "document_upload_chunks",
    orgId: string,
    documentId: string,
    bytes: Uint8Array,
    createdAt: number,
  ): Promise<void> {
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentTooLargeError();
    let index = 0;
    for (let start = 0; start < bytes.byteLength; start += DOCUMENT_CHUNK_BYTES * CHUNKS_PER_WRITE_BATCH) {
      const statements: D1PreparedStatement[] = [];
      for (let offset = start; offset < bytes.byteLength && statements.length < CHUNKS_PER_WRITE_BATCH; offset += DOCUMENT_CHUNK_BYTES) {
        statements.push(this.db.prepare(
          `INSERT INTO ${table} (org_id, document_id, chunk_index, bytes, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).bind(orgId, documentId, index, bytes.slice(offset, offset + DOCUMENT_CHUNK_BYTES), createdAt));
        index += 1;
      }
      await this.db.batch(statements);
    }
  }

  async put(orgId: string, documentId: string, bytes: Uint8Array): Promise<void> {
    await this.writeChunks("document_blobs", orgId, documentId, bytes, Date.now());
  }

  async stage(orgId: string, documentId: string, bytes: Uint8Array, createdAt: number): Promise<void> {
    await this.writeChunks("document_upload_chunks", orgId, documentId, bytes, createdAt);
  }

  finalizeStatements(
    orgId: string,
    documentId: string,
    byteSize: number,
    createdAt: number,
  ): D1PreparedStatement[] {
    const expectedChunks = Math.ceil(byteSize / DOCUMENT_CHUNK_BYTES);
    return [
      this.db.prepare(
        `INSERT INTO document_blobs (org_id, document_id, chunk_index, bytes, created_at)
         SELECT org_id, document_id, chunk_index, bytes, ? FROM document_upload_chunks
         WHERE org_id = ? AND document_id = ? ORDER BY chunk_index`,
      ).bind(createdAt, orgId, documentId),
      this.db.prepare(
        `INSERT INTO batch_assertions (ok)
         SELECT COUNT(*) = ? AND COALESCE(SUM(length(bytes)), 0) = ?
           AND MIN(chunk_index) = 0 AND MAX(chunk_index) = ?
         FROM document_blobs WHERE org_id = ? AND document_id = ?`,
      ).bind(expectedChunks, byteSize, expectedChunks - 1, orgId, documentId),
      this.db.prepare(
        "DELETE FROM document_upload_chunks WHERE org_id = ? AND document_id = ?",
      ).bind(orgId, documentId),
    ];
  }

  async complete(orgId: string, documentId: string, byteSize: number): Promise<boolean> {
    const expectedChunks = Math.ceil(byteSize / DOCUMENT_CHUNK_BYTES);
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS chunk_count, COALESCE(SUM(length(bytes)), 0) AS byte_size,
        MIN(chunk_index) AS first_chunk, MAX(chunk_index) AS last_chunk
       FROM document_blobs WHERE org_id = ? AND document_id = ?`,
    ).bind(orgId, documentId).first<{
      chunk_count: number; byte_size: number; first_chunk: number | null; last_chunk: number | null;
    }>();
    return row !== null && row.chunk_count === expectedChunks && row.byte_size === byteSize
      && row.first_chunk === 0 && row.last_chunk === expectedChunks - 1;
  }

  stream(orgId: string, documentId: string, byteSize: number): ReadableStream<Uint8Array> {
    const db = this.db;
    const expectedChunks = Math.ceil(byteSize / DOCUMENT_CHUNK_BYTES);
    let chunkIndex = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunkIndex >= expectedChunks) {
          controller.close();
          return;
        }
        const stored = await db.prepare(
          "SELECT bytes FROM document_blobs WHERE org_id = ? AND document_id = ? AND chunk_index = ?",
        ).bind(orgId, documentId, chunkIndex).first<ArrayBuffer | Uint8Array | number[]>("bytes");
        if (stored === null) {
          controller.error(new Error("Document bytes became unavailable"));
          return;
        }
        const chunk = stored instanceof Uint8Array
          ? stored
          : stored instanceof ArrayBuffer ? new Uint8Array(stored) : new Uint8Array(stored);
        chunkIndex += 1;
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
  }

  delete(): never {
    throw new Error("Document bytes are immutable and cannot be deleted");
  }
}
