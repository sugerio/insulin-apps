// The XML libraries SAML needs, typed by the hand-written xml-deps.d.ts beside this file: @xmldom/xmldom's own types
// reference the DOM library, which would retype every buffer and response in the Worker.
export { DOMParser } from '@xmldom/xmldom'
export { SignedXml } from 'xml-crypto'
