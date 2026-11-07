import type {SignatureGeometry} from './positioned-signature-geometry.ts';

/** Bind the displayed artwork and placement to the exact input and template checked at commit. */
export async function signaturePreviewHash(artifactHash:string,rolesJson:string,fieldsJson:string,fieldId:string,text:string,imageHash:string,geometry:SignatureGeometry):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify([artifactHash,rolesJson,fieldsJson,fieldId,text,imageHash,geometry.x,geometry.y,geometry.width,geometry.height]));
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}
