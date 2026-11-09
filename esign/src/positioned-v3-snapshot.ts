import {assertNoOverlappingFields,validateTemplateFields,type TemplateField} from './template-fields.ts';

/** A value the signer gives (or, for Date signed, the server's date) for one of their own fields. */
export type CapturedField={id:string;type:string;page:number;rect:TemplateField['rect'];text:string};
export type CapturedFields={role:string;templateFields:TemplateField[];fields:CapturedField[]};

/** The placed fields a document can be signed with: Signature, Date signed and Title, a Signature for every role. */
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
/** The signer's values for their own fields; only the server's signing time supplies Date signed. */
export function capturePositionedV3(raw:unknown,roles:string[],pageCount:number,role:string,now:number,values:unknown):CapturedFields{
 const fields=positionedV3Fields(raw,roles,pageCount),date=dateText(now);
 if(!roles.includes(role)||!values||typeof values!=='object'||Array.isArray(values))throw new Error('Invalid role or inputs');
 const supplied=values as Record<string,unknown>,owned=fields.filter(f=>f.role===role);
 if(Object.keys(supplied).some(id=>!owned.some(f=>f.id===id&&f.type!=='Date signed')))throw new InvalidPositionedV3Input('Unauthorized input');
 const captured:CapturedField[]=[];
 for(const f of owned){
  let text:string;
  if(f.type==='Date signed')text=date;
  else if(!Object.hasOwn(supplied,f.id)){if(f.required)throw new InvalidPositionedV3Input('Missing input');else continue;}
  else text=inputText(f.type,supplied[f.id]);
  captured.push({id:f.id,type:f.type,page:f.page,rect:f.rect,text});
 }
 return {role,templateFields:fields,fields:captured};
}
