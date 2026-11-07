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

/** Applied only when saving an editor version, never when reading historical templates. */
export function assertEditorSigningFields(fields:TemplateField[],roles:string[]):void {
  for(const role of roles){
    const owned=fields.filter(f=>f.role===role);
    if(owned.some(f=>!['Signature','Date signed','Title'].includes(f.type)))throw new Error(`Role ${role}: unsupported field type`);
    const signatures=owned.filter(f=>f.type==='Signature');
    if(signatures.length!==1)throw new Error(`Role ${role}: ${signatures.length===0?'missing':'duplicate'} Signature field`);
  }
}
