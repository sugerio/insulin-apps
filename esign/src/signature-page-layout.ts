import { PageSizes } from 'pdf-lib';

// Keep validation and the renderer on the same page, font size and margins.
export const SIGNATURE_PAGE_SIZE: [number, number] = [...PageSizes.A4];
export const SIGNATURE_PAGE_MARGIN = 50;
export const SIGNATURE_NAME_FONT_SIZE = 12;
export const signatureNameLine = (name: string): string => `Name: ${name}`;
