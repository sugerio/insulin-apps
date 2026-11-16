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

/** One entry of a zip held in memory, as its central directory describes it. */
export interface ZipEntry {
  name: string
  method: number // 0 stored, 8 deflated
  crc: number
  size: number
  data: Uint8Array // the entry's bytes as stored (compressed)
}

/**
 * The entries of a zip held in memory, read from its central directory (no ZIP64, no encryption): null when it isn't
 * a zip this reader can read. Nothing is inflated here.
 */
export function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) return null
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const entries = new Map<string, ZipEntry>()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  try {
    for (let i = 0; i < count; i++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null
      const flags = view.getUint16(at + 8, true)
      const method = view.getUint16(at + 10, true)
      const crc = view.getUint32(at + 16, true)
      const packed = view.getUint32(at + 20, true)
      const size = view.getUint32(at + 24, true)
      const nameLength = view.getUint16(at + 28, true)
      const extra = view.getUint16(at + 30, true)
      const comment = view.getUint16(at + 32, true)
      const local = view.getUint32(at + 42, true)
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
      at += 46 + nameLength + extra + comment
      if (flags & 0x1 || (method !== 0 && method !== 8) || entries.has(name)) return null
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return null
      const localName = view.getUint16(local + 26, true)
      if (decoder.decode(bytes.subarray(local + 30, local + 30 + localName)) !== name) return null
      const start = local + 30 + localName + view.getUint16(local + 28, true)
      if (start + packed > bytes.length) return null
      entries.set(name, { name, method, crc, size, data: bytes.subarray(start, start + packed) })
    }
  } catch {
    return null // a name that isn't UTF-8
  }
  return entries
}

/** An entry's content, checked against its size and CRC; null when it is larger than `maxBytes` or damaged. */
export async function unzipEntry(entry: ZipEntry, maxBytes: number): Promise<Uint8Array | null> {
  if (entry.size > maxBytes) return null
  let out: Uint8Array
  if (entry.method === 0) out = entry.data
  else {
    try {
      const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      out = new Uint8Array(await new Response(stream).arrayBuffer())
    } catch {
      return null
    }
  }
  return out.length === entry.size && crc32(out) === entry.crc ? out : null
}
