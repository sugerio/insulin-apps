import { createCipheriv, createHash } from "node:crypto";
import { PDFDict, PDFDocument, PDFName, PDFRef } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { decryptPdf, md5, rc4 } from "../../src/app/server/lib/pdf-decrypt.ts";

// Revenu Québec's forms are encrypted with an empty password (AES-128, standard security handler revision 4; some
// French ones AES-256, revision 6), which pdf-lib can't read. Its PDFs aren't in the repository, so these tests encrypt
// a small PDF the same way, check that a PDF reader opens it, then that pdf-lib reads it once decrypted.

const PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const hex = (data: Uint8Array) => [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0);
  return out;
};

/** Algorithm 2.B of ISO 32000-2 (revision 6), written apart from the app's, with Node's own hashes and AES. */
function hash2B(password: Uint8Array, salt: Uint8Array): Uint8Array {
  let hash = new Uint8Array(createHash("sha256").update(join(password, salt)).digest());
  for (let round = 0; ; round += 1) {
    const block = join(...Array.from({ length: 64 }, () => join(password, hash)));
    const cipher = createCipheriv("aes-128-cbc", hash.subarray(0, 16), hash.subarray(16, 32)).setAutoPadding(false);
    const encrypted = new Uint8Array(Buffer.concat([cipher.update(block), cipher.final()]));
    const sum = encrypted.subarray(0, 16).reduce((total, byte) => total + byte, 0);
    hash = new Uint8Array(createHash(["sha256", "sha384", "sha512"][sum % 3]!).update(encrypted).digest());
    if (round >= 63 && encrypted.at(-1)! <= round - 31) return hash.subarray(0, 32);
  }
}

/** The encryption dictionary of revision 6 (AES-256) for a file key and a user password, and its object cipher. */
function aes256Security(fileKey: Uint8Array, password: string) {
  const [validation, keySalt] = [Uint8Array.from({ length: 8 }, (_, index) => index + 1), Uint8Array.from({ length: 8 }, (_, index) => index + 11)];
  const user = join(hash2B(bytes(password), validation), validation, keySalt);
  const wrap = createCipheriv("aes-256-cbc", hash2B(bytes(password), keySalt), new Uint8Array(16)).setAutoPadding(false);
  const userKey = new Uint8Array(Buffer.concat([wrap.update(fileKey), wrap.final()]));
  const filler = (length: number) => Uint8Array.from({ length }, (_, index) => (index * 13) & 255);
  return `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(filler(48))}> /U <${hex(user)}> /OE <${hex(filler(32))}> /UE <${hex(userKey)}> /Perms <${hex(filler(16))}> /P -1036 >>`;
}

/**
 * A one-page PDF saying "Revenu Quebec", encrypted as Revenu Québec's forms are (AES-128, or AES-256 with `aes256`, or
 * RC4 with `rc4`); `password` makes it need one. With `xrefStream` its cross-reference is a stream, as PDF 1.5 files
 * often have it, and its font is in an object stream.
 */
async function encryptedPdf(options: { password?: string; aes256?: boolean; rc4?: boolean; xrefStream?: boolean } = {}): Promise<Uint8Array> {
  const id = Uint8Array.from({ length: 16 }, (_, index) => index * 7);
  const owner = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const permissions = new Uint8Array(4);
  new DataView(permissions.buffer).setInt32(0, -1036, true);
  const padded = join(bytes(options.password ?? ""), PADDING).subarray(0, 32);
  let key = md5(join(padded, owner, permissions, id));
  for (let round = 0; round < 50; round += 1) key = md5(key);
  const user = join(
    [...Array(20).keys()].reduce((data, round) => rc4(key.map((byte) => byte ^ round), data), md5(join(PADDING, id))),
    new Uint8Array(16),
  );
  const fileKey = Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + 3) & 255);
  const aes = async (num: number, plain: Uint8Array) => {
    if (options.rc4) return rc4(md5(join(key, Uint8Array.of(num, 0, 0, 0, 0))), plain);
    // Revision 6 encrypts every object with the file key itself.
    const objectKey = options.aes256 ? fileKey : md5(join(key, Uint8Array.of(num, 0, 0, 0, 0), bytes("sAlT")));
    const iv = Uint8Array.from({ length: 16 }, (_, index) => index + num);
    const cipher = await crypto.subtle.importKey("raw", new Uint8Array(objectKey), "AES-CBC", false, ["encrypt"]);
    return join(iv, new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cipher, new Uint8Array(plain))));
  };
  const content = await aes(4, bytes("BT /F1 12 Tf 72 700 Td (Revenu Quebec) Tj ET"));
  const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  // An object stream holds object 5 (the font); the stream is encrypted as a whole, as object 9.
  const packed = await aes(9, bytes(`5 0 ${font}`));
  const objects = [
    bytes("<< /Type /Catalog /Pages 2 0 R >>"),
    bytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    bytes("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 603 774] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    // The length in another object, as Revenu Québec's files often have it.
    join(bytes("<< /Length 6 0 R >>\nstream\n"), content, bytes("\nendstream")),
    bytes(font),
    bytes(String(content.length)),
    bytes(`<< /Title <${hex(await aes(7, bytes("Schedule (test)")))}> >>`),
    bytes(
      options.aes256
        ? aes256Security(fileKey, options.password ?? "")
        : options.rc4
          ? `<< /Filter /Standard /V 2 /R 3 /Length 128 /O <${hex(owner)}> /U <${hex(user)}> /P -1036 >>`
          : `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(owner)}> /U <${hex(user)}> /P -1036 >>`,
    ),
    ...(options.xrefStream ? [join(bytes(`<< /Type /ObjStm /N 1 /First 4 /Length ${packed.length} >>\nstream\n`), packed, bytes("\nendstream"))] : []),
  ];
  const parts: Uint8Array[] = [bytes("%PDF-1.7\n")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(at);
    // With an object stream, the font is only there: nothing else can stand in for it.
    if (options.xrefStream && index === 4) return;
    const object = join(bytes(`${index + 1} 0 obj\n`), body, bytes("\nendobj\n"));
    parts.push(object);
    at += object.length;
  });
  const trailer = `/Root 1 0 R /Info 7 0 R /Encrypt 8 0 R /ID [<${hex(id)}> <${hex(id)}>]`;
  if (options.xrefStream) {
    // Object 10, the cross-reference stream (never encrypted): type, field 2 and field 3 in 1, 4 and 2 bytes. Object 5
    // is the first object of object stream 9.
    const row = (type: number, field: number, gen: number) => Uint8Array.of(type, field >>> 24, (field >>> 16) & 255, (field >>> 8) & 255, field & 255, gen >> 8, gen & 255);
    const rows = [row(0, 0, 65535), ...offsets.map((offset, index) => (index === 4 ? row(2, 9, 0) : row(1, offset, 0))), row(1, at, 0)];
    const data = join(...rows);
    parts.push(join(bytes(`10 0 obj\n<< /Type /XRef /Size 11 /W [1 4 2] ${trailer} /Length ${data.length} >>\nstream\n`), data, bytes("\nendstream\nendobj\n")));
    parts.push(bytes(`startxref\n${at}\n%%EOF\n`));
    return join(...parts);
  }
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  parts.push(bytes(`${xref}trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${at}\n%%EOF\n`));
  return join(...parts);
}

async function textOf(data: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(data), verbosity: 0 }).promise;
  const items = (await (await doc.getPage(1)).getTextContent()).items;
  return items.flatMap((item) => ("str" in item ? [item.str] : [])).join("");
}

describe("decrypting a PDF to fill it", () => {
  it("hashes with MD5 and ciphers with RC4 as the standard says", () => {
    for (const text of ["", "abc", "x".repeat(200)]) expect(hex(md5(bytes(text)))).toBe(createHash("md5").update(text).digest("hex"));
    expect(hex(rc4(bytes("Key"), bytes("Plaintext")))).toBe("bbf316e8d940af0ad3");
  });

  it.each([
    ["AES-128", {}],
    ["AES-256", { aes256: true }],
    ["RC4", { rc4: true }],
    ["AES-128, with a cross-reference stream and an object stream", { xrefStream: true }],
    ["RC4, with a cross-reference stream and an object stream", { rc4: true, xrefStream: true }],
  ])("decrypts a file anyone may open (%s), so pdf-lib reads it: its page and its strings", async (_, options) => {
    const encrypted = await encryptedPdf(options);
    // A PDF reader opens it as it is; pdf-lib refuses it.
    expect(await textOf(encrypted)).toBe("Revenu Quebec");
    await expect(PDFDocument.load(encrypted)).rejects.toThrow(/encrypted/);

    const decrypted = await PDFDocument.load(await decryptPdf(encrypted), { throwOnInvalidObject: true });
    expect(decrypted.getTitle()).toBe("Schedule (test)");
    // The font is read from the decrypted file (from its object stream, when it has one), not a reader's fallback.
    const font = decrypted.context.lookup(PDFRef.of(5, 0), PDFDict);
    expect(font.get(PDFName.of("BaseFont"))).toBe(PDFName.of("Helvetica"));
    const copy = await PDFDocument.create();
    const [page] = await copy.copyPages(decrypted, [0]);
    copy.addPage(page);
    expect(await textOf(await copy.save())).toBe("Revenu Quebec");
  });

  it("passes an unencrypted file through, and refuses one that needs a password", async () => {
    const plain = await (await PDFDocument.create()).save();
    expect(await decryptPdf(plain)).toBe(plain);
    await expect(decryptPdf(await encryptedPdf({ password: "secret" }))).rejects.toThrow(/needs a password/);
    await expect(decryptPdf(await encryptedPdf({ password: "secret", aes256: true }))).rejects.toThrow(/needs a password/);
  });
});
