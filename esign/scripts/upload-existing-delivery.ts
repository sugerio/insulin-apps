import {createHash} from 'node:crypto';

/** Reads only the fixed delivery keys; metadata is local, not proof of an external seal. */
export async function readExistingUploadedDelivery(bucket:Pick<R2Bucket,'get'>,envelopeId:string,finalSha256:string):Promise<Buffer> {
 const prefix=`envelopes/${envelopeId}/local-delivery-v3`;
 const meta=await bucket.get(`${prefix}.json`),file=await bucket.get(`${prefix}.pdf`);
 if(!meta || !file || meta.size>4096 || file.size<5 || file.size>8*1024*1024)throw new Error('Delivery unavailable');
 const metadata=JSON.parse(Buffer.from(await meta.arrayBuffer()).toString('utf8')) as Record<string,unknown>;
 const bytes=Buffer.from(await file.arrayBuffer());
 if(bytes.length!==file.size || !bytes.subarray(0,5).equals(Buffer.from('%PDF-')) || metadata.format!=='esign-local-delivery-v3' || metadata.envelopeId!==envelopeId || metadata.finalSha256!==finalSha256 || typeof metadata.sha256!=='string' || metadata.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new Error('Delivery integrity failure');
 return bytes;
}
