import {positionedFields} from './positioned-template.ts';
import {TYPED_SIGNATURE_FONT,TYPED_SIGNATURE_FONT_HASH} from './typed-signature-image.ts';
import type {PositionedSignatureEvent} from './signature-event.ts';

/** Validate the captured template and recipient input without consulting mutable template rows. */
export function validatePositionedSnapshot(value:unknown,pageCount:number):PositionedSignatureEvent {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid positioned snapshot');
 const p=value as PositionedSignatureEvent;
 if(typeof p.role!=='string'||p.font!==TYPED_SIGNATURE_FONT||p.fontHash!==TYPED_SIGNATURE_FONT_HASH||!Array.isArray(p.templateFields)||!Array.isArray(p.fields)||p.fields.length>20)throw new Error('Invalid positioned snapshot');
 const roles=[...new Set(p.templateFields.map(f=>f?.role))];if(roles.some(r=>typeof r!=='string')||!roles.includes(p.role))throw new Error('Invalid snapshot roles');
 const fields=positionedFields(JSON.stringify(p.templateFields),roles,pageCount),authorized=fields.filter(f=>f.role===p.role),seen=new Set<string>();
 for(const input of p.fields){
  if(!input||typeof input.id!=='string'||seen.has(input.id)||typeof input.text!=='string'||input.text.length>64||!/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(input.text)||typeof input.imageHash!=='string'||!/^[a-f0-9]{64}$/.test(input.imageHash))throw new Error('Invalid signature input');
  const field=authorized.find(f=>f.id===input.id);if(!field||field.page!==input.page||JSON.stringify(field.rect)!==JSON.stringify(input.rect))throw new Error('Unauthorized field input');seen.add(input.id);
 }
 if(authorized.some(f=>f.required&&!seen.has(f.id)))throw new Error('Missing required field');return p;
}
