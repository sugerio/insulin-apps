// Zip files for the in-memory engine's exports, laid out as the real engine's (exporter.ts, zip.ts): each entry
// deflated, then the central directory. And the reader that starts a collection from one (POST .../import-export):
// stored or deflated entries, nothing else (no zip64, no encryption).

const encoder = new TextEncoder()

let table: Uint32Array | undefined
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Bytes through a (de)compression stream, read by hand (no Blob or Response: the app's screen tests run it in jsdom). */
async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  const writing = writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close())
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.byteLength
  }
  await writing
  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** A zip of the entries, in order, each deflated. */
export async function writeZip(entries: [string, string][]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [path, content] of entries) {
    const name = encoder.encode(path)
    const data = encoder.encode(content)
    const packed = await through(data, new CompressionStream('deflate-raw'))
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, 8, true)
    local.setUint16(12, 0x21, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, packed.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0x0800, true)
    entry.setUint16(10, 8, true)
    entry.setUint16(14, 0x21, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, packed.length, true)
    entry.setUint32(24, data.length, true)
    entry.setUint16(28, name.length, true)
    entry.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), name, packed)
    central.push(new Uint8Array(entry.buffer), name)
    offset += 30 + name.length + packed.length
  }
  const size = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of all) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** What readZip lets one entry inflate to unless told otherwise: a text 3 MB, anything else 8 MB. */
const TEXT_BYTES = 3 * 1024 * 1024
const OTHER_BYTES = 8 * 1024 * 1024
/** Compressed bytes are fed to the inflater this many at a time, only as its output is taken. */
const SLICE = 16 * 1024

/** What the reader has inflated in all, for the in-memory engine's tests: an entry nobody reads is never inflated. */
export const zipStats = { inflated: 0 }

/**
 * One entry inflated, never past what the central directory says it holds: the inflating stops as soon as the output
 * passes it, so a small zip claiming a small entry can't unfold into gigabytes. Null when it is larger, shorter, or its
 * CRC doesn't match.
 */
async function inflate(data: Uint8Array, size: number, crc: number): Promise<Uint8Array | null> {
  let at = 0
  const input = new ReadableStream<BufferSource>({
    pull(controller) {
      if (at >= data.length) return controller.close()
      controller.enqueue(data.slice(at, at + SLICE))
      at += SLICE
    },
  }, { highWaterMark: 0 })
  const reader = input.pipeThrough(new DecompressionStream('deflate-raw') as ReadableWritablePair<Uint8Array, BufferSource>).getReader()
  const out = new Uint8Array(size)
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.byteLength > size) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      out.set(value, length)
      length += value.byteLength
      zipStats.inflated += value.byteLength
    }
  } catch {
    return null
  }
  return length === size && crc32(out) === crc ? out : null
}

/** An entry of a zip as its central directory lists it, not read yet. */
export interface ZipEntry {
  name: string
  method: number
  crc: number
  size: number
  data: Uint8Array
}

/**
 * The entries of a zip by name, read from its central directory without inflating anything; null when the bytes
 * aren't a zip this reader can open, or an entry is encrypted or listed twice. Sizes are bounded where an entry is
 * read (readEntry), so one nobody reads may be of any size.
 */
export function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) return null
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const entries = new Map<string, ZipEntry>()
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
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
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (start + packed > bytes.length) return null
    entries.set(name, { name, method, crc, size, data: bytes.subarray(start, start + packed) })
  }
  return entries
}

/** One entry's content, checked against its size and CRC; null when it isn't what the zip says or is past `maxBytes`. */
export async function readEntry(entry: ZipEntry, maxBytes: number): Promise<Uint8Array | null> {
  if (entry.size > maxBytes) return null
  if (entry.method === 0) return entry.data.length === entry.size && crc32(entry.data) === entry.crc ? entry.data : null
  return inflate(entry.data, entry.size, entry.crc)
}

/**
 * Every entry of a zip, read, or null (see zipEntries; when an entry is larger than `entryBytes`, else 3 MB for a
 * text and 8 MB for anything else; and when the entries hold more than `totalBytes` in all, 64 MB unless said
 * otherwise: then nothing is inflated).
 */
export async function readZip(bytes: Uint8Array, limits: { entryBytes?: number; totalBytes?: number } = {}): Promise<Map<string, Uint8Array> | null> {
  const entries = zipEntries(bytes)
  if (!entries) return null
  const bound = (entry: ZipEntry) => limits.entryBytes ?? (entry.name.endsWith('.txt') ? TEXT_BYTES : OTHER_BYTES)
  if ([...entries.values()].some((entry) => entry.size > bound(entry))) return null
  if ([...entries.values()].reduce((sum, entry) => sum + entry.size, 0) > (limits.totalBytes ?? 64 * 1024 * 1024)) return null
  const files = new Map<string, Uint8Array>()
  for (const entry of entries.values()) {
    const content = await readEntry(entry, bound(entry))
    if (!content) return null
    files.set(entry.name, content)
  }
  return files
}
