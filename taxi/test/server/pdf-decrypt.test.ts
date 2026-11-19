import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { decryptPdf, md5, rc4 } from "../../src/app/server/lib/pdf-decrypt.ts";

// Revenu Québec's forms are encrypted with an empty password (AES-128, standard security handler revision 4), which
// pdf-lib can't read. Its PDFs aren't in the repository, so these tests encrypt a small PDF the same way, check that a
// PDF reader opens it, then that pdf-lib reads it once decrypted.

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

/** A one-page PDF saying "Revenu Quebec", encrypted as Revenu Québec's forms are; `password` makes it need one. */
async function encryptedPdf(options: { password?: string } = {}): Promise<Uint8Array> {
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
  const aes = async (num: number, plain: Uint8Array) => {
    const objectKey = md5(join(key, Uint8Array.of(num, 0, 0, 0, 0), bytes("sAlT")));
    const iv = Uint8Array.from({ length: 16 }, (_, index) => index + num);
    const cipher = await crypto.subtle.importKey("raw", new Uint8Array(objectKey), "AES-CBC", false, ["encrypt"]);
    return join(iv, new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cipher, new Uint8Array(plain))));
  };
  const content = await aes(4, bytes("BT /F1 12 Tf 72 700 Td (Revenu Quebec) Tj ET"));
  const objects = [
    bytes("<< /Type /Catalog /Pages 2 0 R >>"),
    bytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    bytes("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 603 774] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    // The length in another object, as Revenu Québec's files often have it.
    join(bytes("<< /Length 6 0 R >>\nstream\n"), content, bytes("\nendstream")),
    bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    bytes(String(content.length)),
    bytes(`<< /Title <${hex(await aes(7, bytes("Schedule (test)")))}> >>`),
    bytes(
      `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(owner)}> /U <${hex(user)}> /P -1036 >>`,
    ),
  ];
  const parts: Uint8Array[] = [bytes("%PDF-1.7\n")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, index) => {
    const object = join(bytes(`${index + 1} 0 obj\n`), body, bytes("\nendobj\n"));
    offsets.push(at);
    parts.push(object);
    at += object.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  parts.push(bytes(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R /Encrypt 8 0 R /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${at}\n%%EOF\n`));
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

  it("decrypts a file anyone may open, so pdf-lib reads it: its page and its strings", async () => {
    const encrypted = await encryptedPdf();
    // A PDF reader opens it as it is; pdf-lib refuses it.
    expect(await textOf(encrypted)).toBe("Revenu Quebec");
    await expect(PDFDocument.load(encrypted)).rejects.toThrow(/encrypted/);

    const decrypted = await PDFDocument.load(await decryptPdf(encrypted));
    expect(decrypted.getTitle()).toBe("Schedule (test)");
    const copy = await PDFDocument.create();
    const [page] = await copy.copyPages(decrypted, [0]);
    copy.addPage(page);
    expect(await textOf(await copy.save())).toBe("Revenu Quebec");
  });

  it("passes an unencrypted file through, and refuses one that needs a password", async () => {
    const plain = await (await PDFDocument.create()).save();
    expect(await decryptPdf(plain)).toBe(plain);
    await expect(decryptPdf(await encryptedPdf({ password: "secret" }))).rejects.toThrow(/needs a password/);
  });
});
