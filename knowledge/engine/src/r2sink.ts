// Streams pieces into one R2 object: uploads, exports.

/**
 * Collects pieces and stores them in R2: one object when small, otherwise a multipart upload whose parts all have
 * the same size but the last, as R2 requires.
 */
export class R2Sink {
  bucket: R2Bucket
  key: string
  partBytes: number
  buffer: Uint8Array[] = []
  buffered = 0
  upload: R2MultipartUpload | null = null
  parts: R2UploadedPart[] = []
  options: R2PutOptions

  constructor(bucket: R2Bucket, key: string, partBytes = 8 * 1024 * 1024, options: R2PutOptions = { httpMetadata: { contentType: 'application/zip' } }) {
    this.bucket = bucket
    this.key = key
    this.partBytes = partBytes
    this.options = options
  }

  write = async (chunk: Uint8Array): Promise<void> => {
    this.buffer.push(chunk)
    this.buffered += chunk.length
    while (this.buffered >= this.partBytes) await this.flushPart(this.partBytes)
  }

  /** Takes the first `count` buffered bytes. */
  take(count: number = this.buffered): Uint8Array {
    const out = new Uint8Array(count)
    let at = 0
    while (at < count) {
      const piece = this.buffer[0]
      const used = Math.min(piece.length, count - at)
      out.set(piece.subarray(0, used), at)
      at += used
      if (used === piece.length) this.buffer.shift()
      else this.buffer[0] = piece.subarray(used)
    }
    this.buffered -= count
    return out
  }

  async flushPart(count: number): Promise<void> {
    this.upload ??= await this.bucket.createMultipartUpload(this.key, { httpMetadata: this.options.httpMetadata, customMetadata: this.options.customMetadata })
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.take(count)))
  }

  /** Stores what was written. `sha256`, when given, is checked by R2 on a single put. */
  async close(sha256?: string): Promise<void> {
    if (!this.upload) {
      await this.bucket.put(this.key, this.take(), { ...this.options, ...(sha256 ? { sha256 } : {}) })
      return
    }
    if (this.buffered) await this.flushPart(this.buffered)
    await this.upload.complete(this.parts)
  }

  async abort(): Promise<void> {
    await this.upload?.abort().catch(() => undefined)
  }
}
