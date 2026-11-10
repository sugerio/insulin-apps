// The parts of @xmldom/xmldom 0.8 and xml-crypto 6 that saml.ts uses (see xml-deps.js for why they're declared here).

export interface XmlNodeList<T> {
  readonly length: number
  item(index: number): T | null
}

export interface XmlNode {
  readonly nodeType: number
  readonly nodeValue: string | null
  readonly firstChild: XmlNode | null
  readonly nextSibling: XmlNode | null
  readonly parentNode: XmlNode | null
}

export interface XmlElement extends XmlNode {
  readonly namespaceURI: string | null
  readonly localName: string
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  getElementsByTagNameNS(namespace: string, localName: string): XmlNodeList<XmlElement>
}

export interface XmlDocument extends XmlNode {
  readonly documentElement: XmlElement | null
  getElementsByTagNameNS(namespace: string, localName: string): XmlNodeList<XmlElement>
}

export class DOMParser {
  constructor(options?: { errorHandler?: { warning?: (message: string) => void; error?: (message: string) => void; fatalError?: (message: string) => void } })
  parseFromString(source: string, mimeType: string): XmlDocument
}

export class SignedXml {
  constructor(options?: { publicCert?: string; getCertFromKeyInfo?: (keyInfo?: unknown) => string | null })
  loadSignature(signature: XmlNode | string): void
  checkSignature(xml: string): boolean
  getSignedReferences(): string[]
}
