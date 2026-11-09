import type { PDFPage } from 'pdf-lib';
import type { TemplateField } from './template-fields.ts';
import { assertSignatureGeometrySafe, signatureGeometry } from './positioned-signature-geometry.ts';
import { assertPositionedV3TextFits, positionedV3TextGeometry } from './positioned-v3-text-fit.ts';
import { renderPositionedV3Text, V3_TEXT_ATLAS_HASH, V3_TEXT_RENDERER } from './positioned-v3-text-render.ts';
import { renderTypedSignature, TYPED_SIGNATURE_FONT, TYPED_SIGNATURE_FONT_HASH } from './typed-signature-image.ts';

/** A box in PDF points with a top-left origin. */
export type Box = { x: number; y: number; width: number; height: number };

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
  name: V3_TEXT_RENDERER, sha256: V3_TEXT_ATLAS_HASH,
  render: renderPositionedV3Text, geometry: positionedV3TextGeometry,
};

export const FIELD_RENDERERS: Readonly<Record<string, FieldRenderer>> = {
  'Signature': {
    name: TYPED_SIGNATURE_FONT, sha256: TYPED_SIGNATURE_FONT_HASH,
    render: renderTypedSignature, geometry: signatureGeometry,
    // A signature may run to the right of its box, but not off the page or over another field.
    check: (page, field, _image, geometry, template) => assertSignatureGeometrySafe(page, field, geometry, template),
  },
  // Text must fit inside its box.
  'Title': { ...text, check: (page, field, image) => assertPositionedV3TextFits(page, field, image) },
  'Date signed': { ...text, check: (page, field, image) => assertPositionedV3TextFits(page, field, image) },
};

export function fieldRenderer(type: string): FieldRenderer {
  const renderer = Object.hasOwn(FIELD_RENDERERS, type) ? FIELD_RENDERERS[type] : undefined;
  if (!renderer) throw new Error(`No renderer for ${type} fields`);
  return renderer;
}

/** The R2 key of a field's rendered image, written before the signature is saved. */
export const fieldImageKey = (envelopeId: string, signatureId: string, fieldId: string) => `envelopes/${envelopeId}/signature-images/${signatureId}/${fieldId}.png`;
