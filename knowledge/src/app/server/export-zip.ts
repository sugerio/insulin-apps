/**
 * A Knowledge export, read from its zip's central directory without unpacking anything: the documents it brings back
 * and the bytes of their text, so starting a collection from it reserves the organization's limits before anything
 * starts. Null when the bytes aren't a zip, or the zip isn't a Knowledge export (no collection.json, or a document
 * without its text).
 */
export interface ExportContents {
  documents: number
  textBytes: number
}

export function exportContents(bytes: Uint8Array): ExportContents | null {
  if (bytes.length < 22) return null
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
  const sizes = new Map<string, number>()
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    sizes.set(name, size)
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  if (!sizes.has('collection.json')) return null
  let documents = 0
  let textBytes = 0
  for (const [name, size] of sizes) {
    const match = /^documents\/([^/]+)\.json$/.exec(name)
    if (!match) continue
    const text = sizes.get(`documents/${match[1]}.txt`)
    if (text === undefined) return null
    documents += 1
    textBytes += text
  }
  return { documents, textBytes }
}
