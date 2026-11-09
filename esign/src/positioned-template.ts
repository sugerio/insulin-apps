import {PDFDocument,PDFName,PDFArray} from 'pdf-lib';
import type {TemplateField} from './template-fields.ts';

/** Fail closed: only unrotated, uncropped PDFs without forms or annotations take placed fields. */
export function validatePositionedPdf(pdf:PDFDocument):void {
 const pages=pdf.getPages();if(!pages.length||pages.length>100||pdf.catalog.get(PDFName.of('AcroForm')))throw new Error('Unsupported PDF');
 for(const page of pages){const m=page.getMediaBox(),c=page.getCropBox();if(page.node.get(PDFName.of('UserUnit'))||(page.node.lookupMaybe(PDFName.of('Annots'),PDFArray)?.size()??0)>0||page.getRotation().angle%360!==0||![m.x,m.y,m.width,m.height,c.x,c.y,c.width,c.height].every(Number.isFinite)||m.x!==0||m.y!==0||m.width<=0||m.height<=0||m.width>14400||m.height>14400||m.x!==c.x||m.y!==c.y||m.width!==c.width||m.height!==c.height)throw new Error('Unsupported page geometry');}
}

export function validatePositionedPlacement(pdf:PDFDocument,fields:TemplateField[]):void {
 for(const field of fields){const page=pdf.getPage(field.page-1);if(field.rect.width*page.getWidth()<20||field.rect.height*page.getHeight()<10)throw new Error('Signature field too small');}
}
