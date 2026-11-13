/**
 * Placed template fields: validating them when a template is saved or read, checking that a PDF
 * and its fields can be signed, and capturing a signer's values at signing. How each field is
 * drawn is in field-render.ts.
 */
import {PDFDocument,PDFName,PDFArray} from 'pdf-lib';

export const FIELD_TYPES=['Signature','Initials','Date signed','Full name','Title','Company','Text box','Checkbox'] as const;
export type TemplateField={id:string;type:string;role:string;page:number;required:boolean;rect:{x:number;y:number;width:number;height:number}};
/** Normalized coordinates use the displayed page's top-left as origin. */
export function validateTemplateFields(value:unknown,roles:string[],pageCount:number):TemplateField[] {
  if(!Array.isArray(value)||value.length>200||!Number.isSafeInteger(pageCount)||pageCount<1)throw new Error('Invalid fields');
  const ids=new Set<string>();
  return value.map((item:unknown)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Invalid field');
    const f=item as Partial<TemplateField>,r=f.rect;
    if(typeof f.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(f.id)||ids.has(f.id)||typeof f.type!=='string'||!FIELD_TYPES.includes(f.type as typeof FIELD_TYPES[number])||typeof f.role!=='string'||!roles.includes(f.role)||!Number.isSafeInteger(f.page)||f.page!<1||f.page!>pageCount||typeof f.required!=='boolean'||!r||typeof r!=='object')throw new Error('Invalid field');
    const {x,y,width,height}=r;
    if(![x,y,width,height].every(v=>typeof v==='number'&&Number.isFinite(v))||x<0||y<0||width<=0||height<=0||x+width>1||y+height>1)throw new Error('Invalid field geometry');
    ids.add(f.id);return {id:f.id,type:f.type,role:f.role,page:f.page!,required:f.required,rect:{x,y,width,height}};
  });
}

// Near touching boundaries, compare the JSON-visible decimal values exactly rather than
// letting binary floating-point rounding turn 0.1 + 0.2 == 0.3 into an overlap.
function decimalLessThanSum(value:number,start:number,length:number):boolean {
  const delta=start+length-value;if(Math.abs(delta)>1e-12)return delta>0;
  const decimal=(n:number)=>{const [mantissa,exponent='0']=n.toString().split('e');const [whole,fraction='']=mantissa.split('.');return {digits:BigInt(whole+fraction),power:Number(exponent)-fraction.length};};
  const parts=[value,start,length].map(decimal),power=Math.min(...parts.map(p=>p.power));
  const scaled=parts.map(p=>p.digits*10n**BigInt(p.power-power));return scaled[0]<scaled[1]+scaled[2];
}
/** Touching edges are allowed; positive-area intersections on one page are not. */
export function assertNoOverlappingFields(fields:TemplateField[]):void {
  for(let i=0;i<fields.length;i++)for(let j=i+1;j<fields.length;j++){
    const a=fields[i],b=fields[j];if(a.page!==b.page)continue;
    if(decimalLessThanSum(a.rect.x,b.rect.x,b.rect.width)&&decimalLessThanSum(b.rect.x,a.rect.x,a.rect.width)&&decimalLessThanSum(a.rect.y,b.rect.y,b.rect.height)&&decimalLessThanSum(b.rect.y,a.rect.y,a.rect.height))throw new Error('Overlapping fields');
  }
}

/** At most this many placed fields can be signed (validateFields), so the editor saves no more. */
export const MAX_SIGNED_FIELDS=20;
/**
 * Applied only when saving an editor version, never when reading historical templates: every role signs at least once
 * (a required Signature field), and may sign in several places; an optional field the signer may leave empty.
 */
export function assertEditorSigningFields(fields:TemplateField[],roles:string[]):void {
  if(fields.length>MAX_SIGNED_FIELDS)throw new Error(`At most ${MAX_SIGNED_FIELDS} fields`);
  for(const role of roles){
    const owned=fields.filter(f=>f.role===role);
    if(owned.some(f=>!['Signature','Date signed','Title'].includes(f.type)))throw new Error(`Role ${role}: unsupported field type`);
    if(!owned.some(f=>f.type==='Signature'))throw new Error(`Role ${role}: missing Signature field`);
    if(!owned.some(f=>f.type==='Signature'&&f.required))throw new Error(`Role ${role}: no required Signature field`);
  }
}

/** Fail closed: only unrotated, uncropped PDFs without forms or annotations take placed fields. */
export function validateFieldsPdf(pdf:PDFDocument):void {
 const pages=pdf.getPages();if(!pages.length||pages.length>100||pdf.catalog.get(PDFName.of('AcroForm')))throw new Error('Unsupported PDF');
 for(const page of pages){const m=page.getMediaBox(),c=page.getCropBox();if(page.node.get(PDFName.of('UserUnit'))||(page.node.lookupMaybe(PDFName.of('Annots'),PDFArray)?.size()??0)>0||page.getRotation().angle%360!==0||![m.x,m.y,m.width,m.height,c.x,c.y,c.width,c.height].every(Number.isFinite)||m.x!==0||m.y!==0||m.width<=0||m.height<=0||m.width>14400||m.height>14400||m.x!==c.x||m.y!==c.y||m.width!==c.width||m.height!==c.height)throw new Error('Unsupported page geometry');}
}

/** Every field is at least 20 × 10 points on its page. */
export function validateFieldPlacement(pdf:PDFDocument,fields:TemplateField[]):void {
 for(const field of fields){const page=pdf.getPage(field.page-1);if(field.rect.width*page.getWidth()<20||field.rect.height*page.getHeight()<10)throw new Error('Signature field too small');}
}

/** A value the signer gives (or, for Date signed, the server's date) for one of their own fields. */
export type CapturedField={id:string;type:string;page:number;rect:TemplateField['rect'];text:string};
export type CapturedFields={role:string;templateFields:TemplateField[];fields:CapturedField[]};

/** The placed fields a document can be signed with: Signature, Date signed and Title, at least one Signature for every role. */
export function validateFields(value:unknown,roles:string[],pageCount:number):TemplateField[]{
 if(!roles.length||roles.some(r=>typeof r!=='string'||!r)||new Set(roles).size!==roles.length)throw new Error('Invalid roles');
 const fields=validateTemplateFields(value,roles,pageCount);
 if(fields.length>MAX_SIGNED_FIELDS||fields.some(f=>!['Signature','Date signed','Title'].includes(f.type))||roles.some(role=>!fields.some(f=>f.role===role&&f.type==='Signature')))throw new Error('Unsupported fields');
 assertNoOverlappingFields(fields);return fields;
}
function dateText(now:number):string{
 if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid signing time');
 return new Date(now).toISOString().slice(0,10);
}
/** A signer's value, or a preview receipt, that a signature may not be recorded with. */
export class InvalidFieldInput extends Error {}
function inputText(type:string,value:unknown):string{
 if(typeof value!=='string')throw new InvalidFieldInput('Invalid input');
 if(type==='Signature'){if(value.length>64||!/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(value))throw new InvalidFieldInput('Invalid signature');}
 else if(type==='Title'){if(value.length<1||value.length>128||value.trim()!==value||!/^[\x20-\x7e]+$/.test(value))throw new InvalidFieldInput('Invalid title');}
 else throw new Error('Invalid input type');
 return value;
}
/** The signer's values for their own fields; only the server's signing time supplies Date signed. */
export function captureFields(raw:unknown,roles:string[],pageCount:number,role:string,now:number,values:unknown):CapturedFields{
 const fields=validateFields(raw,roles,pageCount),date=dateText(now);
 if(!roles.includes(role)||!values||typeof values!=='object'||Array.isArray(values))throw new Error('Invalid role or inputs');
 const supplied=values as Record<string,unknown>,owned=fields.filter(f=>f.role===role);
 if(Object.keys(supplied).some(id=>!owned.some(f=>f.id===id&&f.type!=='Date signed')))throw new InvalidFieldInput('Unauthorized input');
 const captured:CapturedField[]=[];
 for(const f of owned){
  let text:string;
  if(f.type==='Date signed')text=date;
  else if(!Object.hasOwn(supplied,f.id)){if(f.required)throw new InvalidFieldInput('Missing input');else continue;}
  else text=inputText(f.type,supplied[f.id]);
  captured.push({id:f.id,type:f.type,page:f.page,rect:f.rect,text});
 }
 return {role,templateFields:fields,fields:captured};
}
