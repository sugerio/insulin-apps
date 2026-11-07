import {PDFDocument} from 'pdf-lib';
import {validateTemplateFields, assertNoOverlappingFields, assertEditorSigningFields, type TemplateField} from './template-fields.ts';

/** Experimental editor versions, not yet usable to create signing envelopes. */
export async function saveEditorTemplate(db:D1Database,bucket:R2Bucket,tenantId:string,bytes:Uint8Array,roles:string[],rawFields:unknown):Promise<string>{
  if(bytes.byteLength<1||bytes.byteLength>5*1024*1024||!Array.isArray(roles)||roles.length<1||roles.length>20||roles.some(r=>typeof r!=='string'||!r.trim()||r!==r.trim()||r.length>64)||new Set(roles.map(r=>r.toLowerCase())).size!==roles.length)throw new Error('Invalid template');
  const pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true});
  const pageCount=pdf.getPageCount();if(pageCount<1||pageCount>100)throw new Error('Invalid PDF');
  const fields=validateTemplateFields(rawFields,roles,pageCount);assertEditorSigningFields(fields,roles);assertNoOverlappingFields(fields);const id=crypto.randomUUID(),key=`editor-templates/${id}/source.pdf`;
  const stored=await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}});
  if(!stored)throw new Error('Object conflict');
  // Preserve the object on ambiguous D1 failure; it may already have committed.
  await db.prepare('INSERT INTO editor_templates (id,tenant_id,object_key,roles_json,fields_json,created_at) VALUES (?,?,?,?,?,?)').bind(id,tenantId,key,JSON.stringify(roles),JSON.stringify(fields),Date.now()).run();
  return id;
}
export async function loadEditorTemplate(db:D1Database,tenantId:string,id:string):Promise<{id:string;objectKey:string;roles:string[];fields:TemplateField[]}|null>{
  const row=await db.prepare('SELECT id,object_key,roles_json,fields_json FROM editor_templates WHERE tenant_id=? AND id=?').bind(tenantId,id).first<{id:string;object_key:string;roles_json:string;fields_json:string}>();
  if(!row)return null;return {id:row.id,objectKey:row.object_key,roles:JSON.parse(row.roles_json),fields:JSON.parse(row.fields_json)};
}
