import {assertNoOverlappingFields,validateTemplateFields,type TemplateField} from './template-fields.ts';
import type {SignatureEvent} from './signature-event.ts';
import {V3_TEXT_RENDERER,V3_TEXT_ATLAS_HASH} from './positioned-v3-text-render.ts';
import {TYPED_SIGNATURE_FONT,TYPED_SIGNATURE_FONT_HASH} from './typed-signature-image.ts';

type V3Field={id:string;type:string;page:number;rect:TemplateField['rect'];text:string};
export type PositionedV3Draft={role:string;templateFields:TemplateField[];fields:V3Field[]};
export type PositionedV3Snapshot={role:string;templateFields:TemplateField[];textRenderer:string;textAtlasHash:string;signatureRenderer:string;signatureFontHash:string;fields:(V3Field & {imageHash:string;geometry?:import('./positioned-signature-geometry.ts').SignatureGeometry;previewId?:string})[]};

export function positionedV3Fields(value:unknown,roles:string[],pageCount:number):TemplateField[]{
 if(!roles.length||roles.some(r=>typeof r!=='string'||!r)||new Set(roles).size!==roles.length)throw new Error('Invalid roles');
 const fields=validateTemplateFields(value,roles,pageCount);
 if(fields.length>20||fields.some(f=>!['Signature','Date signed','Title'].includes(f.type))||roles.some(role=>!fields.some(f=>f.role===role&&f.type==='Signature')))throw new Error('Unsupported fields');
 assertNoOverlappingFields(fields);return fields;
}
function dateText(now:number):string{
 if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid signing time');
 return new Date(now).toISOString().slice(0,10);
}
export class InvalidPositionedV3Input extends Error {}
function inputText(type:string,value:unknown):string{
 if(typeof value!=='string')throw new InvalidPositionedV3Input('Invalid input');
 if(type==='Signature'){if(value.length>64||!/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(value))throw new InvalidPositionedV3Input('Invalid signature');}
 else if(type==='Title'){if(value.length<1||value.length>128||value.trim()!==value||!/^[\x20-\x7e]+$/.test(value))throw new InvalidPositionedV3Input('Invalid title');}
 else throw new Error('Invalid input type');
 return value;
}
/** Unmounted candidate: only the server's recorded signing time supplies Date signed. */
export function capturePositionedV3(raw:unknown,roles:string[],pageCount:number,role:string,now:number,values:unknown):PositionedV3Draft{
 const fields=positionedV3Fields(raw,roles,pageCount),date=dateText(now);
 if(!roles.includes(role)||!values||typeof values!=='object'||Array.isArray(values))throw new Error('Invalid role or inputs');
 const supplied=values as Record<string,unknown>,owned=fields.filter(f=>f.role===role);
 if(Object.keys(supplied).some(id=>!owned.some(f=>f.id===id&&f.type!=='Date signed')))throw new InvalidPositionedV3Input('Unauthorized input');
 const captured:V3Field[]=[];
 for(const f of owned){
  let text:string;
  if(f.type==='Date signed')text=date;
  else if(!Object.hasOwn(supplied,f.id)){if(f.required)throw new InvalidPositionedV3Input('Missing input');else continue;}
  else text=inputText(f.type,supplied[f.id]);
  captured.push({id:f.id,type:f.type,page:f.page,rect:f.rect,text});
 }
 return {role,templateFields:fields,fields:captured};
}
/** Validates captured facts without consulting a mutable template. */
export function validatePositionedV3(value:unknown,pageCount:number,consentedAt:number):PositionedV3Snapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid snapshot');
 const p=value as PositionedV3Snapshot;
 if(typeof p.role!=='string'||p.textRenderer!==V3_TEXT_RENDERER||p.textAtlasHash!==V3_TEXT_ATLAS_HASH||p.signatureRenderer!==TYPED_SIGNATURE_FONT||p.signatureFontHash!==TYPED_SIGNATURE_FONT_HASH||!Array.isArray(p.templateFields)||!Array.isArray(p.fields))throw new Error('Invalid snapshot');
 const roles=[...new Set(p.templateFields.map(f=>f?.role))];
 if(roles.some(r=>typeof r!=='string'))throw new Error('Invalid roles');
 const fields=positionedV3Fields(p.templateFields,roles,pageCount),owned=fields.filter(f=>f.role===p.role),seen=new Set<string>(),date=dateText(consentedAt);
 if(!roles.includes(p.role))throw new Error('Invalid role');
 for(const input of p.fields){
  if(!input||typeof input.id!=='string'||seen.has(input.id)||typeof input.imageHash!=='string'||!/^[a-f0-9]{64}$/.test(input.imageHash))throw new Error('Invalid captured input');
  const f=owned.find(f=>f.id===input.id);
  if(!f||f.type!==input.type||f.page!==input.page||JSON.stringify(f.rect)!==JSON.stringify(input.rect))throw new Error('Invalid captured field');
  if(f.type==='Date signed'){if(input.text!==date && (input.previewId!==undefined||input.text!==new Date(consentedAt).toISOString()))throw new Error('Invalid captured date');if(input.previewId!==undefined&&!/^[a-f0-9-]{36}$/.test(input.previewId))throw new Error('Invalid preview identity');}else {if(input.previewId!==undefined)throw new Error('Unexpected preview identity');inputText(f.type,input.text);}
  seen.add(f.id);
 }
 if(owned.some(f=>(f.required||f.type==='Date signed')&&!seen.has(f.id)))throw new Error('Missing captured input');
 return p;
}
/** Independent encoding; v1 and v2 encoders and stored evidence are unchanged. */
export function canonicalPositionedV3(event:SignatureEvent,p:PositionedV3Snapshot):string{
 return JSON.stringify(['esign-signature-event-v3',event.envelopeId,event.sequence,event.previousHash,event.signatureId,event.taskId,event.recipientName,event.artifactId,event.artifactHash,event.otpVerifiedAt,event.consentedAt,p.role,p.textRenderer,p.textAtlasHash,p.signatureRenderer,p.signatureFontHash,p.templateFields.map(f=>[f.id,f.type,f.role,f.page,f.required,f.rect.x,f.rect.y,f.rect.width,f.rect.height]),p.fields.map(f=>[f.id,f.type,f.page,f.rect.x,f.rect.y,f.rect.width,f.rect.height,f.text,f.imageHash,...(f.geometry?[f.geometry.x,f.geometry.y,f.geometry.width,f.geometry.height]:[])]),...(p.fields.some(f=>f.previewId!==undefined)?[p.fields.filter(f=>f.type==='Date signed').map(f=>[f.id,f.previewId])]:[])]);
}
