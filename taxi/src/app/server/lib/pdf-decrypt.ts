// Revenu Québec publishes its forms encrypted: anyone may open them (the password to open them is empty), but pdf-lib,
// which fills the forms, can't read an encrypted file, and pdf-lib can't take the encryption off. So before a form is
// filled, its strings and streams are decrypted with the empty password, as a PDF reader does, and the file is passed
// on without its encryption. The CRA's forms aren't encrypted and pass through unchanged.
//
// Only what such a file needs is handled: the standard security handler, revisions 2 to 4, with RC4 or AES-128 (ISO
// 32000-1, 7.6), and revision 6 with AES-256 (ISO 32000-2, 7.6.4.3.3), which some of Revenu Québec's French forms use.
// A file that needs a password is refused. The objects are read in the order they
// are in the file, so the offsets in its cross-reference sections are left as they are: they no longer match once
// the objects are decrypted, but pdf-lib reads the objects in order too and doesn't use them.

type Value =
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "name"; name: string; start: number; end: number }
  | { kind: "string"; bytes: Uint8Array; start: number; end: number }
  | { kind: "array"; items: Value[]; start: number; end: number }
  | { kind: "dict"; entries: Entry[]; start: number; end: number }
  | { kind: "ref"; num: number; gen: number; start: number; end: number }
  | { kind: "word"; word: string; start: number; end: number };
interface Entry {
  key: string;
  /** Where the key starts: an entry is removed from there to the end of its value. */
  start: number;
  value: Value;
}
interface PdfObject {
  num: number;
  gen: number;
  value: Value;
  /** A stream's data, between "stream" and "endstream". */
  stream?: { start: number; end: number };
}
/** A replacement of bytes start to end. */
interface Edit {
  start: number;
  end: number;
  bytes: Uint8Array;
}
type Method = "rc4" | "aes" | "none";

/** The 32 bytes a password is padded with (an empty password is all of them). */
const PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const ENCRYPT = bytesOf("/Encrypt");

/** The file without its encryption, or the file itself when it isn't encrypted. */
export async function decryptPdf(bytes: Uint8Array): Promise<Uint8Array> {
  if (indexOf(bytes, ENCRYPT, 0) < 0) return bytes;
  const { objects, trailers } = new Reader(bytes).file();
  const xrefStreams = objects.filter((object) => object.stream && entry(object.value, "Type")?.kind === "name" && (entry(object.value, "Type") as { name: string }).name === "XRef");
  const sections = [...trailers, ...xrefStreams.map((object) => object.value)];
  const pointer = sections.map((dict) => entry(dict, "Encrypt")).find((value) => value?.kind === "ref") as Extract<Value, { kind: "ref" }> | undefined;
  if (!pointer) return bytes;
  const encryptObject = objects.find((object) => object.num === pointer.num && object.gen === pointer.gen);
  const ids = sections.map((dict) => entry(dict, "ID")).find((value) => value?.kind === "array") as Extract<Value, { kind: "array" }> | undefined;
  const firstId = ids?.items[0]?.kind === "string" ? ids.items[0].bytes : new Uint8Array();
  if (!encryptObject) throw new Error("The PDF's encryption dictionary is missing");
  const crypt = await standardSecurity(encryptObject.value, firstId);

  const edits: Edit[] = [];
  // The encryption entry comes out of every trailer, so the result reads as an unencrypted file.
  for (const dict of sections) {
    for (const each of dict.kind === "dict" ? dict.entries : []) if (each.key === "Encrypt") edits.push({ start: each.start, end: each.value.end, bytes: new Uint8Array() });
  }
  const lengths = new Map(objects.filter((object) => object.value.kind === "number").map((object) => [`${object.num} ${object.gen}`, (object.value as { value: number }).value]));
  for (const object of objects) {
    // The encryption dictionary and the cross-reference streams were never encrypted.
    if (object === encryptObject || xrefStreams.includes(object)) continue;
    const key = objectKey(crypt, object.num, object.gen);
    for (const string of stringsIn(object.value)) {
      edits.push({ start: string.start, end: string.end, bytes: bytesOf(`<${hex(await decrypt(crypt.strings, key, string.bytes))}>`) });
    }
    if (!object.stream) continue;
    const type = entry(object.value, "Type");
    const plain = type?.kind === "name" && type.name === "Metadata" && !crypt.encryptMetadata;
    const length = entry(object.value, "Length");
    const declared = length?.kind === "number" ? length.value : length?.kind === "ref" ? lengths.get(`${length.num} ${length.gen}`) : undefined;
    const end = streamEnd(bytes, object.stream, declared, crypt.streams);
    const data = plain ? bytes.subarray(object.stream.start, end) : await decrypt(crypt.streams, key, bytes.subarray(object.stream.start, end));
    edits.push({ start: object.stream.start, end, bytes: data });
    if (length) edits.push({ start: length.start, end: length.end, bytes: bytesOf(String(data.length)) });
  }
  return splice(bytes, edits);
}

interface Crypt {
  key: Uint8Array;
  streams: Method;
  strings: Method;
  encryptMetadata: boolean;
  /** Revision 6 (AES-256): every object is encrypted with the file key itself. */
  aes256: boolean;
}

/** The file key from the standard security handler's dictionary, with the empty password (algorithms 2, 4 and 5; 2.A). */
async function standardSecurity(dict: Value, firstId: Uint8Array): Promise<Crypt> {
  const number = (key: string, fallback: number) => {
    const value = entry(dict, key);
    return value?.kind === "number" ? value.value : fallback;
  };
  const string = (key: string) => {
    const value = entry(dict, key);
    if (value?.kind !== "string") throw new Error(`The PDF's encryption dictionary has no ${key}`);
    return value.bytes;
  };
  const filter = entry(dict, "Filter");
  const [version, revision] = [number("V", 0), number("R", 2)];
  const aes256 = version === 5 && revision === 6;
  if (filter?.kind !== "name" || filter.name !== "Standard" || !(aes256 || (version >= 1 && version <= 4 && revision >= 2 && revision <= 4))) {
    throw new Error("The PDF uses an encryption this app doesn't read");
  }
  const metadata = entry(dict, "EncryptMetadata");
  const encryptMetadata = !(metadata?.kind === "word" && metadata.word === "false");
  const method = (name: string): Method => {
    if (version < 4) return "rc4";
    const filterName = entry(dict, name);
    if (filterName?.kind !== "name" || filterName.name === "Identity") return "none";
    const filters = entry(dict, "CF");
    const crypt = filters?.kind === "dict" ? entry(filters, filterName.name) : undefined;
    const cfm = crypt ? entry(crypt, "CFM") : undefined;
    if (cfm?.kind === "name" && cfm.name === (aes256 ? "AESV3" : "AESV2")) return "aes";
    if (cfm?.kind === "name" && cfm.name === "V2" && !aes256) return "rc4";
    if (cfm?.kind === "name" && cfm.name === "None") return "none";
    throw new Error("The PDF uses an encryption this app doesn't read");
  };
  if (aes256) {
    // Algorithm 2.A: the empty password opens the file if its hash with U's validation salt is U's first 32 bytes; the
    // file key is UE decrypted with its hash with U's key salt.
    const user = string("U");
    const valid = await hash2B(user.subarray(32, 40));
    if (!valid.every((byte, index) => byte === user[index])) throw new Error("The PDF needs a password to open");
    const key = await aesCbcRaw(await hash2B(user.subarray(40, 48)), new Uint8Array(16), string("UE").subarray(0, 32));
    return { key, streams: method("StmF"), strings: method("StrF"), encryptMetadata, aes256 };
  }
  const length = version === 1 ? 5 : number("Length", 40) / 8;
  const permissions = new Uint8Array(4);
  new DataView(permissions.buffer).setInt32(0, number("P", 0), true);
  let key = md5(concat(PADDING, string("O").subarray(0, 32), permissions, firstId, revision >= 4 && !encryptMetadata ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array()));
  if (revision >= 3) for (let round = 0; round < 50; round += 1) key = md5(key.subarray(0, length));
  key = key.slice(0, length);
  // The empty password opens the file only if it gives the U entry back.
  const user = string("U");
  const check = revision === 2 ? rc4(key, PADDING) : [...Array(20).keys()].reduce((data, round) => rc4(key.map((byte) => byte ^ round), data), md5(concat(PADDING, firstId)));
  if (!check.every((byte, index) => index >= (revision === 2 ? 32 : 16) || byte === user[index])) throw new Error("The PDF needs a password to open");
  return { key, streams: method("StmF"), strings: method("StrF"), encryptMetadata, aes256: false };
}

/**
 * Algorithm 2.B, the hash of revision 6, for the empty password and no user key: SHA-256 of the salt, then rounds of
 * AES-128 over 64 copies of the hash, each hashed again with SHA-256, -384 or -512 as the encrypted bytes say, until
 * at least 64 rounds are done and the last byte allows it.
 */
async function hash2B(salt: Uint8Array): Promise<Uint8Array> {
  let hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(salt)));
  for (let round = 0; ; round += 1) {
    const block = concat(...Array.from({ length: 64 }, () => hash));
    const key = await crypto.subtle.importKey("raw", hash.slice(0, 16), "AES-CBC", false, ["encrypt"]);
    // Web Crypto pads; the data is whole blocks, so the padding is one more block at the end, left off.
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: hash.slice(16, 32) }, key, new Uint8Array(block))).subarray(0, block.length);
    const sum = encrypted.subarray(0, 16).reduce((total, byte) => total + byte, 0);
    hash = new Uint8Array(await crypto.subtle.digest(["SHA-256", "SHA-384", "SHA-512"][sum % 3]!, new Uint8Array(encrypted)));
    if (round >= 63 && encrypted.at(-1)! <= round - 31) return hash.slice(0, 32);
  }
}

/**
 * AES-CBC decryption of whole blocks without padding. Web Crypto checks the padding, so one more block is added: the
 * encryption of an empty message after the last block, which decrypts to a full block of padding.
 */
async function aesCbcRaw(keyBytes: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(keyBytes), "AES-CBC", false, ["encrypt", "decrypt"]);
  const pad = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: data.slice(-16) }, key, new Uint8Array()));
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(iv) }, key, new Uint8Array(concat(data, pad))));
}

/** Each object's own key (algorithm 1); with AES-256, the file key. */
function objectKey(crypt: Crypt, num: number, gen: number): Uint8Array {
  if (crypt.aes256) return crypt.key;
  const salt = crypt.streams === "aes" || crypt.strings === "aes" ? bytesOf("sAlT") : new Uint8Array();
  const id = Uint8Array.of(num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255);
  return md5(concat(crypt.key, id, salt)).slice(0, Math.min(crypt.key.length + 5, 16));
}

async function decrypt(method: Method, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (method === "none") return data;
  if (method === "rc4") return rc4(key, data);
  // AES-128 (or AES-256) in CBC mode, its first 16 bytes the initialization vector, padded as PKCS #7.
  if (data.length <= 16) return new Uint8Array();
  const aes = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-CBC", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: data.slice(0, 16) }, aes, data.slice(16)));
}

/**
 * Where a stream's data ends: its declared length when it leads to "endstream", or else just before the end of line
 * before "endstream" (AES data is a whole number of 16-byte blocks, which tells an end of line from a last byte).
 */
function streamEnd(bytes: Uint8Array, stream: { start: number; end: number }, declared: number | undefined, method: Method): number {
  if (declared !== undefined && stream.start + declared <= stream.end && /^\s*$/.test(String.fromCharCode(...bytes.subarray(stream.start + declared, stream.end)))) {
    return stream.start + declared;
  }
  const ends = [stream.end, ...(bytes[stream.end - 1] === 10 ? [stream.end - 1] : []), ...(bytes[stream.end - 2] === 13 && bytes[stream.end - 1] === 10 ? [stream.end - 2] : []), ...(bytes[stream.end - 1] === 13 ? [stream.end - 1] : [])];
  if (method === "aes") return ends.find((end) => (end - stream.start) % 16 === 0) ?? stream.end;
  return ends.at(-1)!;
}

function stringsIn(value: Value): Extract<Value, { kind: "string" }>[] {
  if (value.kind === "string") return [value];
  if (value.kind === "array") return value.items.flatMap(stringsIn);
  if (value.kind === "dict") return value.entries.flatMap((each) => stringsIn(each.value));
  return [];
}

function entry(dict: Value | undefined, key: string): Value | undefined {
  return dict?.kind === "dict" ? dict.entries.find((each) => each.key === key)?.value : undefined;
}

function splice(bytes: Uint8Array, edits: Edit[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    parts.push(bytes.subarray(at, edit.start), edit.bytes);
    at = edit.end;
  }
  parts.push(bytes.subarray(at));
  return concat(...parts);
}

/** Reads a PDF's objects and trailers in file order: just enough syntax to find each string and stream. */
class Reader {
  private at = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  file(): { objects: PdfObject[]; trailers: Value[] } {
    const objects: PdfObject[] = [];
    const trailers: Value[] = [];
    while (this.skipSpace() < this.bytes.length) {
      const start = this.at;
      const header = this.objectHeader();
      if (header) {
        const value = this.value();
        const object: PdfObject = { ...header, value };
        this.skipSpace();
        if (this.startsWith("stream")) {
          this.at += 6;
          if (this.bytes[this.at] === 13) this.at += 1;
          if (this.bytes[this.at] === 10) this.at += 1;
          const end = indexOf(this.bytes, bytesOf("endstream"), this.at);
          if (end < 0) throw new Error("A PDF stream has no end");
          object.stream = { start: this.at, end };
          this.at = end + 9;
        }
        objects.push(object);
        continue;
      }
      this.at = start;
      const token = this.value();
      if (token.kind === "word" && token.word === "trailer") trailers.push(this.value());
    }
    return { objects, trailers };
  }

  /** "12 0 obj", or nothing (and the position is left for the caller to reset). */
  private objectHeader(): { num: number; gen: number } | undefined {
    const num = this.integer();
    if (num === undefined) return undefined;
    this.skipSpace();
    const gen = this.integer();
    if (gen === undefined) return undefined;
    this.skipSpace();
    if (!this.startsWith("obj") || !this.isDelimiterOrSpace(this.at + 3)) return undefined;
    this.at += 3;
    return { num, gen };
  }

  private value(): Value {
    this.skipSpace();
    const start = this.at;
    const char = this.bytes[this.at];
    if (char === 0x3c && this.bytes[this.at + 1] === 0x3c) {
      this.at += 2;
      const entries: Entry[] = [];
      while (this.skipSpace() < this.bytes.length && !(this.bytes[this.at] === 0x3e && this.bytes[this.at + 1] === 0x3e)) {
        const keyStart = this.at;
        const key = this.value();
        if (key.kind !== "name") throw new Error("A PDF dictionary key isn't a name");
        entries.push({ key: key.name, start: keyStart, value: this.value() });
      }
      this.at += 2;
      return { kind: "dict", entries, start, end: this.at };
    }
    if (char === 0x3c) {
      const end = indexOf(this.bytes, Uint8Array.of(0x3e), this.at);
      const digits = String.fromCharCode(...this.bytes.subarray(this.at + 1, end)).replace(/\s/g, "");
      this.at = end + 1;
      return { kind: "string", bytes: fromHex(digits.length % 2 === 0 ? digits : `${digits}0`), start, end: this.at };
    }
    if (char === 0x28) return { kind: "string", bytes: this.literal(), start, end: this.at };
    if (char === 0x5b) {
      this.at += 1;
      const items: Value[] = [];
      while (this.skipSpace() < this.bytes.length && this.bytes[this.at] !== 0x5d) items.push(this.value());
      this.at += 1;
      return { kind: "array", items, start, end: this.at };
    }
    if (char === 0x2f) {
      this.at += 1;
      const name = this.regular();
      return { kind: "name", name, start, end: this.at };
    }
    const word = this.regular() || String.fromCharCode(this.bytes[this.at++]!);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      // "12 0 R" is a reference.
      if (/^\d+$/.test(word)) {
        const after = this.at;
        this.skipSpace();
        const gen = this.integer();
        this.skipSpace();
        if (gen !== undefined && this.bytes[this.at] === 0x52 && this.isDelimiterOrSpace(this.at + 1)) {
          this.at += 1;
          return { kind: "ref", num: Number(word), gen, start, end: this.at };
        }
        this.at = after;
      }
      return { kind: "number", value: Number(word), start, end: this.at };
    }
    return { kind: "word", word, start, end: this.at };
  }

  /** A literal string's bytes: nested parentheses, and the escapes of 7.3.4.2. */
  private literal(): Uint8Array {
    const out: number[] = [];
    let depth = 0;
    this.at += 1;
    for (;;) {
      const char = this.bytes[this.at++];
      if (char === undefined) throw new Error("A PDF string has no end");
      if (char === 0x28) depth += 1;
      if (char === 0x29 && depth-- === 0) return Uint8Array.from(out);
      if (char !== 0x5c) {
        out.push(char);
        continue;
      }
      const next = this.bytes[this.at++]!;
      const escapes: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
      if (next in escapes) out.push(escapes[next]!);
      else if (next >= 0x30 && next <= 0x37) {
        let octal = next - 0x30;
        for (let digits = 1; digits < 3 && this.bytes[this.at]! >= 0x30 && this.bytes[this.at]! <= 0x37; digits += 1) octal = octal * 8 + this.bytes[this.at++]! - 0x30;
        out.push(octal & 255);
      } else if (next === 13) {
        if (this.bytes[this.at] === 10) this.at += 1;
      } else if (next !== 10) out.push(next);
    }
  }

  private integer(): number | undefined {
    const start = this.at;
    while (this.bytes[this.at]! >= 0x30 && this.bytes[this.at]! <= 0x39) this.at += 1;
    return this.at > start && this.isDelimiterOrSpace(this.at) ? Number(String.fromCharCode(...this.bytes.subarray(start, this.at))) : undefined;
  }

  private regular(): string {
    const start = this.at;
    while (this.at < this.bytes.length && !this.isDelimiterOrSpace(this.at)) this.at += 1;
    return String.fromCharCode(...this.bytes.subarray(start, this.at));
  }

  /** Skips white space and comments; returns the position. */
  private skipSpace(): number {
    for (;;) {
      while (this.at < this.bytes.length && isSpace(this.bytes[this.at]!)) this.at += 1;
      if (this.bytes[this.at] !== 0x25) return this.at;
      while (this.at < this.bytes.length && this.bytes[this.at] !== 10 && this.bytes[this.at] !== 13) this.at += 1;
    }
  }

  private startsWith(word: string): boolean {
    return [...word].every((char, index) => this.bytes[this.at + index] === char.charCodeAt(0));
  }

  private isDelimiterOrSpace(at: number): boolean {
    const char = this.bytes[at];
    return char === undefined || isSpace(char) || "()<>[]{}/%".includes(String.fromCharCode(char));
  }
}

function isSpace(char: number): boolean {
  return char === 0 || char === 9 || char === 10 || char === 12 || char === 13 || char === 32;
}

function indexOf(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let at = from; at <= bytes.length - needle.length; at += 1) {
    for (let index = 0; index < needle.length; index += 1) if (bytes[at + index] !== needle[index]) continue outer;
    return at;
  }
  return -1;
}

function bytesOf(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(digits: string): Uint8Array {
  return Uint8Array.from({ length: digits.length / 2 }, (_, index) => parseInt(digits.slice(index * 2, index * 2 + 2), 16));
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + state[i]! + key[i % key.length]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  const out = new Uint8Array(data.length);
  for (let index = 0, i = 0, j = 0; index < data.length; index += 1) {
    i = (i + 1) & 255;
    j = (j + state[i]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
    out[index] = data[index]! ^ state[(state[i]! + state[j]!) & 255]!;
  }
  return out;
}

/** MD5 (RFC 1321): the security handler's hash, which Web Crypto doesn't offer. */
export function md5(data: Uint8Array): Uint8Array {
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (data.length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(data.length / 0x20000000), true);
  const hash = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    let [a, b, c, d] = hash as [number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const round = index >> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const word = [index, (5 * index + 1) % 16, (3 * index + 5) % 16, (7 * index) % 16][round]!;
      const sum = (a + f + constants[index]! + view.getUint32(chunk + word * 4, true)) >>> 0;
      const shift = shifts[round * 4 + (index % 4)]!;
      [a, d, c] = [d, c, b];
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
  }
  const out = new Uint8Array(16);
  hash.forEach((word, index) => new DataView(out.buffer).setUint32(index * 4, word, true));
  return out;
}
