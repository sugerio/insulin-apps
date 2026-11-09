/**
 * The RFC 3161 timestamp query of the managed seal (managed-seal.ts sends it to the TSA and
 * verifies the reply with worker-rfc3161-verifier.ts): version 1, a SHA-256 message imprint, a
 * 16-byte nonce and certReq true, DER-encoded.
 */
const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;};
const tlv=(tag:number,value:Uint8Array)=>{if(value.length>=128)throw new Error('Invalid timestamp request');return concat(new Uint8Array([tag,value.length]),value);};

/** `imprint` is a SHA-256 digest; `nonce` is 16 bytes whose first byte is 1, so it is a positive DER INTEGER of fixed length. */
export function timestampQuery(imprint:Uint8Array,nonce:Uint8Array):Uint8Array<ArrayBuffer>{
 if(imprint.length!==32||nonce.length!==16||nonce[0]!==1)throw new Error('Invalid timestamp query');
 const algorithm=new Uint8Array([0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01,0x05,0x00]);
 return tlv(0x30,concat(new Uint8Array([0x02,0x01,0x01]),tlv(0x30,concat(algorithm,tlv(0x04,imprint))),tlv(0x02,nonce),new Uint8Array([0x01,0x01,0xff])));
}
