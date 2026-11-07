const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!;
const ORDER = Uint8Array.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'.match(/../g)!, byte => parseInt(byte, 16));

/** Strict DER ECDSA signature to P-256 P1363 encoding. Conversion does not verify the signature. */
export function p256DerToP1363(input: Uint8Array): Uint8Array {
  const invalid = (): never => { throw new Error('Invalid P-256 DER signature'); };
  if (!(input instanceof Uint8Array) || !(bufferGetter.call(input) instanceof ArrayBuffer)) return invalid();
  const length = lengthGetter.call(input) as number;
  if (length < 8 || length > 72) return invalid();
  const bytes = new Uint8Array(input);
  if (bytes[0] !== 0x30 || bytes[1] !== length - 2) return invalid();
  let offset = 2;
  const readScalar = (): Uint8Array => {
    if (bytes[offset++] !== 2) return invalid();
    const size = bytes[offset++];
    if (!size || size > 33 || offset + size > bytes.length) return invalid();
    const first = bytes[offset];
    if (first & 0x80 || (size > 1 && first === 0 && !(bytes[offset + 1] & 0x80))) return invalid();
    const skip = first === 0 ? 1 : 0;
    const n = size - skip;
    if (n === 0 || n > 32) return invalid();
    const scalar = new Uint8Array(32);
    scalar.set(bytes.subarray(offset + skip, offset + size), 32 - n);
    offset += size;
    let nonzero = false, comparison = 0;
    for (let i = 0; i < 32; i++) {
      nonzero ||= scalar[i] !== 0;
      if (!comparison && scalar[i] !== ORDER[i]) comparison = scalar[i] < ORDER[i] ? -1 : 1;
    }
    if (!nonzero || comparison >= 0) return invalid();
    return scalar;
  };
  const r = readScalar(), s = readScalar();
  if (offset !== bytes.length) return invalid();
  const result = new Uint8Array(64);
  result.set(r); result.set(s, 32);
  return result;
}
