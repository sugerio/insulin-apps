import { bytesToHex } from "../encoding.ts";
import { BodyTooLargeError } from "../http.ts";
import { MAX_UPLOAD_BYTES } from "./types.ts";

const ALLOWED = new Set([
  "application/pdf", "image/png", "image/jpeg", "text/csv", "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export interface BufferedUpload {
  bytes: Uint8Array;
  contentType: string;
  sha256Bytes: Uint8Array;
  sha256Hex: string;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  outer: for (let index = 0; index <= bytes.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function magicMatches(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "application/pdf") return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (contentType === "image/png") return bytes.length >= 8
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return isZip(bytes) && containsAscii(bytes, "[Content_Types].xml") && containsAscii(bytes, "word/document.xml");
  }
  if (contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return isZip(bytes) && containsAscii(bytes, "[Content_Types].xml") && containsAscii(bytes, "xl/workbook.xml");
  }
  if (contentType === "text/plain" || contentType === "text/csv") {
    if (bytes.includes(0)) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
    catch { return false; }
  }
  return false;
}

export class UnsupportedDocumentTypeError extends Error { override name = "UnsupportedDocumentTypeError"; }

export async function bufferUpload(request: Request): Promise<BufferedUpload> {
  const lengthHeader = request.headers.get("Content-Length");
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_UPLOAD_BYTES)) {
    throw new BodyTooLargeError();
  }
  if (!request.body) throw new UnsupportedDocumentTypeError("Documents cannot be empty");
  const reader = request.body.getReader();
  const allocated = declaredLength === null ? null : new Uint8Array(declaredLength);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const nextSize = size + value.byteLength;
    if (nextSize > MAX_UPLOAD_BYTES || (allocated && nextSize > allocated.byteLength)) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    if (allocated) allocated.set(value, size);
    else chunks.push(value);
    size = nextSize;
  }
  if (allocated && size !== allocated.byteLength) throw new UnsupportedDocumentTypeError("Content-Length does not match the document body");
  const body = allocated ?? new Uint8Array(size);
  if (!allocated) {
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  }
  if (body.byteLength === 0) throw new UnsupportedDocumentTypeError("Documents cannot be empty");
  const contentType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (!ALLOWED.has(contentType) || !magicMatches(contentType, body)) {
    throw new UnsupportedDocumentTypeError("The declared document type is not allowed or does not match its bytes");
  }
  const sha256Bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return { bytes: body, contentType, sha256Bytes, sha256Hex: bytesToHex(sha256Bytes) };
}
