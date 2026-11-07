import type {PDFPage} from 'pdf-lib';
import type {TemplateField} from './template-fields.ts';

export class PositionedV3TextDoesNotFitError extends Error {
 constructor(){super('Text field too small');}
}

// The reference H in the 128px Caveat atlas has 72 ink rows at 30pt;
// H and date digits in the 32px Liberation atlas have 16 ink rows. Their
// visible height is intentionally 80% of the signature reference height.
export const V3_TEXT_HEIGHT=27;

/** Fixed PDF-point placement, top-left origin, independent of field size. */
export function positionedV3TextGeometry(page:PDFPage,field:Pick<TemplateField,'rect'>,image:Uint8Array){
 const view=new DataView(image.buffer,image.byteOffset,image.byteLength),width=view.getUint32(16),height=view.getUint32(20);
 if(!width||height!==32)throw new Error('Invalid text image');
 return {x:field.rect.x*page.getWidth(),y:field.rect.y*page.getHeight(),width:width*V3_TEXT_HEIGHT/height,height:V3_TEXT_HEIGHT};
}

/** Unlike signatures, text must fit inside its static field. */
export function assertPositionedV3TextFits(page:PDFPage,field:Pick<TemplateField,'rect'>,image:Uint8Array):void {
 const g=positionedV3TextGeometry(page,field,image);
 const epsilon=1e-9; // Normalized coordinates can lose fractions of a PDF point to floating-point rounding.
 if(g.width>field.rect.width*page.getWidth()+epsilon||g.height>field.rect.height*page.getHeight()+epsilon||g.x+g.width>page.getWidth()+epsilon||g.y+g.height>page.getHeight()+epsilon)throw new PositionedV3TextDoesNotFitError();
}
