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

/** The entries of a zip by name, or null when the bytes aren't a zip this reader can open. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array> | null> {
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
  const files = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null
    const method = view.getUint16(at + 10, true)
    const packed = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extra = view.getUint16(at + 30, true)
    const comment = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extra + comment
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return null
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = bytes.subarray(start, start + packed)
    if (method === 0) files.set(name, data)
    else if (method === 8) files.set(name, await through(data, new DecompressionStream('deflate-raw')))
    else return null
  }
  return files
}
