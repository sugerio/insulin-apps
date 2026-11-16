// A small ZIP writer for exports: each entry deflated with the platform's CompressionStream, written in order, then
// the central directory. Entries are at most a few megabytes (a document's text), so each is compressed whole;
// the archive itself is handed out in pieces, so it never has to fit in memory.

const encoder = new TextEncoder()

let crcTable: Uint32Array | undefined
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface Central {
  name: Uint8Array
  crc: number
  compressed: number
  size: number
  offset: number
}

export class ZipWriter {
  entries: Central[] = []
  offset = 0
  emit: (chunk: Uint8Array) => Promise<void>

  constructor(emit: (chunk: Uint8Array) => Promise<void>) {
    this.emit = emit
  }

  async add(path: string, content: string | Uint8Array): Promise<void> {
    const name = encoder.encode(path)
    const data = typeof content === 'string' ? encoder.encode(content) : content
    const compressed = await deflate(data)
    const crc = crc32(data)
    const header = new DataView(new ArrayBuffer(30))
    header.setUint32(0, 0x04034b50, true)
    header.setUint16(4, 20, true) // version needed
    header.setUint16(6, 0x0800, true) // UTF-8 names
    header.setUint16(8, 8, true) // deflate
    header.setUint16(10, 0, true) // time
    header.setUint16(12, 0x21, true) // date: 1980-01-01
    header.setUint32(14, crc, true)
    header.setUint32(18, compressed.length, true)
    header.setUint32(22, data.length, true)
    header.setUint16(26, name.length, true)
    header.setUint16(28, 0, true)
    this.entries.push({ name, crc, compressed: compressed.length, size: data.length, offset: this.offset })
    await this.write(new Uint8Array(header.buffer))
    await this.write(name)
    await this.write(compressed)
  }

  async finish(): Promise<number> {
    const start = this.offset
    for (const e of this.entries) {
      const header = new DataView(new ArrayBuffer(46))
      header.setUint32(0, 0x02014b50, true)
      header.setUint16(4, 20, true)
      header.setUint16(6, 20, true)
      header.setUint16(8, 0x0800, true)
      header.setUint16(10, 8, true)
      header.setUint16(12, 0, true)
      header.setUint16(14, 0x21, true)
      header.setUint32(16, e.crc, true)
      header.setUint32(20, e.compressed, true)
      header.setUint32(24, e.size, true)
      header.setUint16(28, e.name.length, true)
      header.setUint32(42, e.offset, true)
      await this.write(new Uint8Array(header.buffer))
      await this.write(e.name)
    }
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, this.entries.length, true)
    end.setUint16(10, this.entries.length, true)
    end.setUint32(12, this.offset - start, true)
    end.setUint32(16, start, true)
    await this.write(new Uint8Array(end.buffer))
    return this.offset
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.offset + bytes.length > 0xffffffff) throw new Error('export larger than 4 GB')
    this.offset += bytes.length
    await this.emit(bytes)
  }
}

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

  constructor(bucket: R2Bucket, key: string, partBytes = 8 * 1024 * 1024) {
    this.bucket = bucket
    this.key = key
    this.partBytes = partBytes
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
    this.upload ??= await this.bucket.createMultipartUpload(this.key, { httpMetadata: { contentType: 'application/zip' } })
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.take(count)))
  }

  async close(): Promise<void> {
    if (!this.upload) {
      await this.bucket.put(this.key, this.take(), { httpMetadata: { contentType: 'application/zip' } })
      return
    }
    if (this.buffered) await this.flushPart(this.buffered)
    await this.upload.complete(this.parts)
  }

  async abort(): Promise<void> {
    await this.upload?.abort().catch(() => undefined)
  }
}
