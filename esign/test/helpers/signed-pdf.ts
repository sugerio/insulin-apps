import {artifactObjectKey} from '../../src/signatures.ts';

/** The signed PDF of an envelope (the last signature's rendered output), read from storage and checked against its hash. */
export async function signedPdf(db:D1Database,bucket:R2Bucket,envelopeId:string):Promise<ArrayBuffer>{
 const row=await db.prepare("SELECT output_artifact_id,output_sha256 FROM signatures WHERE envelope_id=? AND status='DONE' ORDER BY sequence DESC LIMIT 1").bind(envelopeId).first<{output_artifact_id:string;output_sha256:string}>();
 if(!row)throw new Error('No signed PDF');
 const object=await bucket.get(artifactObjectKey(envelopeId,row.output_artifact_id));
 if(!object)throw new Error('Signed PDF missing');
 const bytes=await object.arrayBuffer();
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
 if(hash!==row.output_sha256)throw new Error('Signed PDF changed');
 return bytes;
}
