export class SignatureGeometryConflict extends Error {}
import type {PDFPage} from 'pdf-lib';
import type {TemplateField} from './template-fields.ts';

export type SignatureGeometry={x:number;y:number;width:number;height:number};
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
