import {V3_TEXT_ATLAS_BASE64} from './positioned-v3-text-atlas.ts';

// Fixed bitmap, dimensions and PNG encoder are part of this renderer version.
export const V3_TEXT_RENDERER='liberation-sans-bitmap-v2';
export const V3_TEXT_ATLAS_HASH='00c8a01aedf3d88c0c64a72eefdc20e7a081907e0232dcfcb5ebebe16d151c49';
const atlas=Uint8Array.from(atob(V3_TEXT_ATLAS_BASE64),c=>c.charCodeAt(0));
function crc32(data:Uint8Array):number {let c=0xffffffff;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1));}return (c^0xffffffff)>>>0;}
function u32(n:number):Uint8Array{return new Uint8Array([n>>>24,n>>>16,n>>>8,n]);}
function concat(...parts:Uint8Array[]):Uint8Array {const out=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;}
function chunk(type:string,data:Uint8Array):Uint8Array {const tag=new TextEncoder().encode(type),content=concat(tag,data);return concat(u32(data.length),content,u32(crc32(content)));}
/** Local bitmap text artwork; no platform fonts or native canvas at runtime. */
export async function renderPositionedV3Text(text:string):Promise<Uint8Array>{
 if(typeof text!=='string'||text.length<1||text.length>128||text.trim()!==text||!/^[\x20-\x7e]+$/.test(text))throw new Error('Invalid text');
 const height=32,glyphs=Array.from(text,char=>{
  let left=24,right=-1;const code=char.charCodeAt(0)-32;
  for(let y=0;y<height;y++)for(let x=0;x<24;x++){const bit=code*24*height+y*24+x;if(atlas[bit>>>3]&(128>>(bit&7))){left=Math.min(left,x);right=Math.max(right,x);}}
  return {code,left,right,advance:right<left?6:right-left+1+1};
 }),width=glyphs.reduce((sum,g)=>sum+g.advance,0),stride=width*4+1,pixels=new Uint8Array(stride*height);
 let offset=0;for(const g of glyphs){for(let y=0;y<height;y++)for(let x=g.left;x<=g.right;x++){
  const bit=g.code*24*height+y*24+x;
  if(atlas[bit>>>3]&(128>>(bit&7))){const p=y*stride+1+(offset+x-g.left)*4;pixels[p]=20;pixels[p+1]=28;pixels[p+2]=48;pixels[p+3]=255;}
 }offset+=g.advance;}
 const blocks:Uint8Array[]=[new Uint8Array([0x78,0x01])];let a=1,b=0;for(const value of pixels){a=(a+value)%65521;b=(b+a)%65521;}
 for(let i=0;i<pixels.length;i+=65535){const len=Math.min(65535,pixels.length-i),last=i+len===pixels.length;blocks.push(new Uint8Array([last?1:0,len&255,len>>>8,(~len)&255,(~len>>>8)&255]),pixels.subarray(i,i+len));}
 blocks.push(u32(((b<<16)|a)>>>0));const header=concat(u32(width),u32(height),new Uint8Array([8,6,0,0,0]));return concat(new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',concat(...blocks)),chunk('IEND',new Uint8Array()));
}
