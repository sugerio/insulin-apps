import { bytesToHex, utf8 } from "./encoding.ts";

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value))));
}
