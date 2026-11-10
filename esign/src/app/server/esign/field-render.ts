/**
 * How placed fields are drawn, and the signature page of a document without them: the bitmap
 * renderers that turn a value into a PNG, where each image goes on the page and the checks that
 * it may go there, the receipt that binds a preview to what is signed, and the appended
 * signature page's layout and recipient-name check. Which fields exist is in fields.ts.
 */
import { PageSizes, PDFDocument, StandardFonts, type PDFPage } from 'pdf-lib';
import type { TemplateField } from './fields.ts';
import { SIGNATURE_ATLAS_BASE64 } from './fonts/signature-atlas.ts';
import { TEXT_ATLAS_BASE64 } from './fonts/text-atlas.ts';

// --- Bitmap text renderers -------------------------------------------------------------------
// Each renderer's name and atlas hash are recorded with every signed field (render_json), so the
// fixed bitmaps, their dimensions and the PNG encoder below are part of the renderer version.

export const TYPED_SIGNATURE_FONT='caveat-bitmap-v2';
export const TYPED_SIGNATURE_FONT_HASH='8939915eee4471c416b9d5e718c9e78db58511aa38f67c803bfafeda0d549d61';
export const TEXT_RENDERER='liberation-sans-bitmap-v2';
export const TEXT_ATLAS_HASH='00c8a01aedf3d88c0c64a72eefdc20e7a081907e0232dcfcb5ebebe16d151c49';
const decode=(base64:string)=>Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
const signatureAtlas=decode(SIGNATURE_ATLAS_BASE64),textAtlas=decode(TEXT_ATLAS_BASE64);

function crc32(data:Uint8Array):number {let c=0xffffffff;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));}return (c^0xffffffff)>>>0;}
function u32(n:number):Uint8Array{return new Uint8Array([n>>>24,n>>>16,n>>>8,n]);}
function concat(...parts:Uint8Array[]):Uint8Array {const out=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;}
function chunk(type:string,data:Uint8Array):Uint8Array {const tag=new TextEncoder().encode(type),content=concat(tag,data);return concat(u32(data.length),content,u32(crc32(content)));}
/**
 * Local bitmap text artwork; no platform fonts or native canvas at runtime. The atlas holds one
 * `cell` × `height` 1-bit glyph per printable ASCII character; each glyph is cropped to its ink
 * and followed by `gap` pixels, and a glyph without ink advances `blank` pixels. The output is an
 * RGBA PNG with stored (uncompressed) deflate blocks.
 */
function renderBitmapText(atlas:Uint8Array,cell:number,height:number,blank:number,gap:number,text:string):Uint8Array{
 const glyphs=Array.from(text,char=>{
  let left=cell,right=-1;const code=char.charCodeAt(0)-32;
  for(let y=0;y<height;y++)for(let x=0;x<cell;x++){const bit=code*cell*height+y*cell+x;if(atlas[bit>>>3]&(128>>(bit&7))){left=Math.min(left,x);right=Math.max(right,x);}}
  return {code,left,right,advance:right<left?blank:right-left+1+gap};
 }),width=glyphs.reduce((sum,g)=>sum+g.advance,0),stride=width*4+1,pixels=new Uint8Array(stride*height);
 let offset=0;for(const g of glyphs){for(let y=0;y<height;y++)for(let x=g.left;x<=g.right;x++){
  const bit=g.code*cell*height+y*cell+x;
  if(atlas[bit>>>3]&(128>>(bit&7))){const p=y*stride+1+(offset+x-g.left)*4;pixels[p]=20;pixels[p+1]=28;pixels[p+2]=48;pixels[p+3]=255;}
 }offset+=g.advance;}
 const blocks:Uint8Array[]=[new Uint8Array([0x78,0x01])];let a=1,b=0;for(const value of pixels){a=(a+value)%65521;b=(b+a)%65521;}
 for(let i=0;i<pixels.length;i+=65535){const len=Math.min(65535,pixels.length-i),last=i+len===pixels.length;blocks.push(new Uint8Array([last?1:0,len&255,len>>>8,(~len)&255,(~len>>>8)&255]),pixels.subarray(i,i+len));}
 blocks.push(u32(((b<<16)|a)>>>0));const header=concat(u32(width),u32(height),new Uint8Array([8,6,0,0,0]));return concat(new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',concat(...blocks)),chunk('IEND',new Uint8Array()));
}

/** A typed signature in Caveat: Latin letters and single spaces, 1–64 characters, 128 pixels high. */
export async function renderTypedSignature(text:string):Promise<Uint8Array>{
 if(typeof text!=='string'||text.length<1||text.length>64||!/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(text))throw new Error('Invalid text');
 return renderBitmapText(signatureAtlas,96,128,24,3,text);
}

/** Title and Date signed text in Liberation Sans: printable ASCII, 1–128 characters, 32 pixels high. */
export async function renderText(text:string):Promise<Uint8Array>{
 if(typeof text!=='string'||text.length<1||text.length>128||text.trim()!==text||!/^[\x20-\x7e]+$/.test(text))throw new Error('Invalid text');
 return renderBitmapText(textAtlas,24,32,6,1,text);
}

// --- Geometry ----------------------------------------------------------------------------------

/** A box in PDF points with a top-left origin. */
export type Box = { x: number; y: number; width: number; height: number };

export class SignatureGeometryConflict extends Error {}
export type SignatureGeometry=Box;
export const SIGNATURE_HEIGHT=30;
/** PDF-point geometry, with a top-left origin. */
export function signatureGeometry(page:PDFPage,field:Pick<TemplateField,'rect'>,image:Uint8Array):SignatureGeometry {
 const view=new DataView(image.buffer,image.byteOffset,image.byteLength),width=view.getUint32(16),height=view.getUint32(20);
 if(!width||height!==128)throw new Error('Invalid signature image');
 return {x:field.rect.x*page.getWidth(),y:field.rect.y*page.getHeight(),width:width*SIGNATURE_HEIGHT/height,height:SIGNATURE_HEIGHT};
}
export function assertSignatureGeometrySafe(page:PDFPage,field:TemplateField,geometry:SignatureGeometry,fields:TemplateField[]):void {
 const {x,y,width,height}=geometry;
 if(height>field.rect.height*page.getHeight() || x+width>page.getWidth() || y+height>page.getHeight())throw new SignatureGeometryConflict('Signature does not fit safely on the page');
 for(const other of fields){if(other.id===field.id||other.page!==field.page)continue;const r=other.rect,ox=r.x*page.getWidth(),oy=r.y*page.getHeight();if(x<ox+r.width*page.getWidth()&&ox<x+width&&y<oy+r.height*page.getHeight()&&oy<y+height)throw new SignatureGeometryConflict('Signature overlaps another field');}
}

export class TextDoesNotFitError extends Error {
 constructor(){super('Text field too small');}
}

// The reference H in the 128px Caveat atlas has 72 ink rows at 30pt;
// H and date digits in the 32px Liberation atlas have 16 ink rows. Their
// visible height is intentionally 80% of the signature reference height.
export const TEXT_HEIGHT=27;

/** Fixed PDF-point placement, top-left origin, independent of field size. */
export function textGeometry(page:PDFPage,field:Pick<TemplateField,'rect'>,image:Uint8Array):Box{
 const view=new DataView(image.buffer,image.byteOffset,image.byteLength),width=view.getUint32(16),height=view.getUint32(20);
 if(!width||height!==32)throw new Error('Invalid text image');
 return {x:field.rect.x*page.getWidth(),y:field.rect.y*page.getHeight(),width:width*TEXT_HEIGHT/height,height:TEXT_HEIGHT};
}

/** Unlike signatures, text must fit inside its static field. */
export function assertTextFits(page:PDFPage,field:Pick<TemplateField,'rect'>,image:Uint8Array):void {
 const g=textGeometry(page,field,image);
 const epsilon=1e-9; // Normalized coordinates can lose fractions of a PDF point to floating-point rounding.
 if(g.width>field.rect.width*page.getWidth()+epsilon||g.height>field.rect.height*page.getHeight()+epsilon||g.x+g.width>page.getWidth()+epsilon||g.y+g.height>page.getHeight()+epsilon)throw new TextDoesNotFitError();
}

// --- Preview receipts --------------------------------------------------------------------------

/** Bind the displayed artwork and placement to the exact input and template checked at commit. */
export async function signaturePreviewHash(artifactHash:string,rolesJson:string,fieldsJson:string,fieldId:string,text:string,imageHash:string,geometry:SignatureGeometry):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify([artifactHash,rolesJson,fieldsJson,fieldId,text,imageHash,geometry.x,geometry.y,geometry.width,geometry.height]));
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}

// --- Renderer registry -------------------------------------------------------------------------

/**
 * How each signable field type is drawn: the renderer that turns the value into a PNG, where the
 * image goes on the page, and the check that it may go there. Adding a field type adds an entry
 * here; the stored signature (render_json) names the type and renderer, so the table stays as is.
 */
export type FieldRenderer = {
  /** Renderer identity, recorded with each field and checked again when the PDF is rendered. */
  name: string;
  sha256: string;
  render(value: string): Promise<Uint8Array>;
  geometry(page: PDFPage, field: Pick<TemplateField, 'rect'>, image: Uint8Array): Box;
  /** Throws when the image does not fit safely; template is every placed field of the document. */
  check(page: PDFPage, field: TemplateField, image: Uint8Array, geometry: Box, template: TemplateField[]): void;
};

const text: Omit<FieldRenderer, 'check'> = {
  name: TEXT_RENDERER, sha256: TEXT_ATLAS_HASH,
  render: renderText, geometry: textGeometry,
};

export const FIELD_RENDERERS: Readonly<Record<string, FieldRenderer>> = {
  'Signature': {
    name: TYPED_SIGNATURE_FONT, sha256: TYPED_SIGNATURE_FONT_HASH,
    render: renderTypedSignature, geometry: signatureGeometry,
    // A signature may run to the right of its box, but not off the page or over another field.
    check: (page, field, _image, geometry, template) => assertSignatureGeometrySafe(page, field, geometry, template),
  },
  // Text must fit inside its box.
  'Title': { ...text, check: (page, field, image) => assertTextFits(page, field, image) },
  'Date signed': { ...text, check: (page, field, image) => assertTextFits(page, field, image) },
};

export function fieldRenderer(type: string): FieldRenderer {
  const renderer = Object.hasOwn(FIELD_RENDERERS, type) ? FIELD_RENDERERS[type] : undefined;
  if (!renderer) throw new Error(`No renderer for ${type} fields`);
  return renderer;
}

/** The R2 key of a field's rendered image, written before the signature is saved. */
export const fieldImageKey = (envelopeId: string, signatureId: string, fieldId: string) => `envelopes/${envelopeId}/signature-images/${signatureId}/${fieldId}.png`;

// --- Appended signature page (documents without placed fields) --------------------------------

// Keep validation and the renderer on the same page, font size and margins.
export const SIGNATURE_PAGE_SIZE: [number, number] = [...PageSizes.A4];
export const SIGNATURE_PAGE_MARGIN = 50;
export const SIGNATURE_NAME_FONT_SIZE = 12;
export const signatureNameLine = (name: string): string => `Name: ${name}`;

/** The signing renderer uses this font; validate every recipient before creating an envelope. */
export async function assertRenderableRecipientNames(names: string[]): Promise<void> {
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const availableWidth = SIGNATURE_PAGE_SIZE[0] - 2 * SIGNATURE_PAGE_MARGIN;
    for (const name of names) {
      const line = signatureNameLine(name);
      font.encodeText(line);
      // drawText emits one Tj without kerning adjustments, unlike widthOfTextAtSize(line).
      const width = Array.from(line, char => font.widthOfTextAtSize(char, SIGNATURE_NAME_FONT_SIZE)).reduce((total, advance) => total + advance, 0);
      if (width + 1e-7 > availableWidth) throw new Error('Recipient name does not fit');
    }
  } catch {
    throw new Error('Unsupported recipient name for local PDF renderer');
  }
}
