// SAML 2.0 for an organization's identity provider (DESIGN.md §7): the AuthnRequest we send with the HTTP-Redirect
// binding, the SP metadata, and the checks on the response the provider posts back. Only a narrow XML-DSig profile is
// accepted (RSA-SHA256 or stronger, SHA-256 or stronger digests, exclusive C14N), every claim is read from the copy of
// the element the signature covers, and duplicate IDs, extra signatures or extra assertions are refused, so signature
// wrapping finds nothing to wrap.
import { base64, fromBase64, randomBytes, utf8 } from '../crypto.ts'
import { DOMParser, SignedXml, type XmlDocument, type XmlElement, type XmlNode } from './xml-deps.js'

export const NS = {
  protocol: 'urn:oasis:names:tc:SAML:2.0:protocol',
  assertion: 'urn:oasis:names:tc:SAML:2.0:assertion',
  metadata: 'urn:oasis:names:tc:SAML:2.0:metadata',
  dsig: 'http://www.w3.org/2000/09/xmldsig#',
} as const

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4
const HTTP_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer'
const NAME_ID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
const NAME_ID_UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'
const EXCLUSIVE_C14N = ['http://www.w3.org/2001/10/xml-exc-c14n#', 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments']
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const SIGNATURE_ALGORITHMS = [
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
]
const DIGEST_ALGORITHMS = ['http://www.w3.org/2001/04/xmlenc#sha256', 'http://www.w3.org/2001/04/xmlenc#sha512']
const ID_ATTRIBUTES = ['ID', 'Id', 'id']
/** Where providers put the address when the NameID isn't one. */
const EMAIL_ATTRIBUTES = ['email', 'mail', 'emailaddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3']
const NAME_ATTRIBUTES = ['displayname', 'name', 'http://schemas.microsoft.com/identity/claims/displayname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']
const GIVEN_NAME_ATTRIBUTES = ['givenname', 'firstname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']
const SURNAME_ATTRIBUTES = ['surname', 'sn', 'lastname', 'familyname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']

export const MAX_RESPONSE_BYTES = 256 * 1024
/** Deeper element nesting is refused before parsing, so no walk of the document can recurse without bound. */
export const MAX_DEPTH = 64
const CLOCK_SKEW_MS = 2 * 60 * 1000

export type SamlProblem =
  | 'malformed' | 'unsolicited' | 'idp_status' | 'unsigned' | 'invalid_signature' | 'wrong_issuer' | 'wrong_destination'
  | 'wrong_recipient' | 'wrong_audience' | 'expired' | 'no_email'

/** A refused response. The code is safe to log; the message is for people and never carries assertion contents. */
export class SamlError extends Error {
  override name = 'SamlError'
  readonly code: SamlProblem
  constructor(code: SamlProblem, message: string) {
    super(message)
    this.code = code
  }
}

class XmlError extends Error {
  override name = 'XmlError'
}

function malformed(message: string): SamlError {
  return new SamlError('malformed', message)
}

/**
 * How deeply the elements nest, from the markup alone (attribute values can't hold `<`, so every `<` starts markup):
 * comments, CDATA and processing instructions are skipped. Stops counting past `limit`.
 */
export function nestingDepth(xml: string, limit: number): number {
  let depth = 0
  let deepest = 0
  const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)[^<>]*?(\/?)>/g
  for (const match of xml.matchAll(markup)) {
    const token = match[0]
    if (token.startsWith('<!--') || token.startsWith('<![CDATA[') || token.startsWith('<?')) continue
    if (match[1]) depth -= 1
    else if (!match[2]) {
      depth += 1
      if (depth > deepest) deepest = depth
      if (deepest > limit) break
    }
  }
  return deepest
}

/** Untrusted XML, parsed strictly: no DTD (so no entity expansion), and any parser warning or error aborts. */
function parseXml(xml: string): XmlDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw malformed('DTDs are not allowed')
  if (nestingDepth(xml, MAX_DEPTH) > MAX_DEPTH) throw malformed('The response is nested too deeply')
  const fail = () => { throw malformed('The response is not well-formed XML') }
  let doc: XmlDocument | undefined
  try {
    doc = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(xml, 'text/xml')
  } catch (error) {
    if (error instanceof SamlError) throw error
    throw malformed('The response is not well-formed XML')
  }
  if (!doc?.documentElement) throw malformed('The response is empty')
  return doc
}

function isElement(node: XmlNode | null | undefined, ns: string, localName: string): node is XmlElement {
  return node != null && node.nodeType === ELEMENT_NODE && (node as XmlElement).namespaceURI === ns && (node as XmlElement).localName === localName
}

function childElements(parent: XmlNode, ns: string, localName: string): XmlElement[] {
  const out: XmlElement[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling) if (isElement(node, ns, localName)) out.push(node)
  return out
}

function allChildElements(parent: XmlNode): XmlElement[] {
  const out: XmlElement[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling) if (node.nodeType === ELEMENT_NODE) out.push(node as XmlElement)
  return out
}

function optionalChild(parent: XmlNode, ns: string, localName: string): XmlElement | null {
  const matches = childElements(parent, ns, localName)
  if (matches.length > 1) throw new XmlError(`Expected at most one ${localName}`)
  return matches[0] ?? null
}

function requiredChild(parent: XmlNode, ns: string, localName: string): XmlElement {
  const child = optionalChild(parent, ns, localName)
  if (!child) throw new XmlError(`Missing ${localName}`)
  return child
}

/** Character data only (comments can't truncate it: every text node counts). */
function simpleText(element: XmlElement): string {
  let text = ''
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) text += node.nodeValue ?? ''
    else if (node.nodeType === ELEMENT_NODE) throw new XmlError(`${element.localName} must not contain elements`)
  }
  return text.trim()
}

function forEachElement(root: XmlNode, visit: (element: XmlElement) => void): void {
  for (let node = root.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== ELEMENT_NODE) continue
    visit(node as XmlElement)
    forEachElement(node, visit)
  }
}

function attribute(element: XmlElement, name: string): string | null {
  return element.hasAttribute(name) ? element.getAttribute(name) : null
}

function structure<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof XmlError) throw malformed(error.message)
    throw error
  }
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** SAML ids are XML NCNames, so they can't start with a digit. */
export function newRequestId(): string {
  return `_${[...randomBytes(20)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function instant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface ServiceProvider {
  entityId: string
  acsUrl: string
}

/** An unsigned AuthnRequest asking for the response at our ACS with the HTTP-POST binding. */
export function authnRequest(sp: ServiceProvider, id: string, destination: string, now: number): string {
  return `<samlp:AuthnRequest xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}" ID="${escapeXml(id)}" Version="2.0"`
    + ` IssueInstant="${instant(now)}" Destination="${escapeXml(destination)}" AssertionConsumerServiceURL="${escapeXml(sp.acsUrl)}"`
    + ` ProtocolBinding="${HTTP_POST}"><saml:Issuer>${escapeXml(sp.entityId)}</saml:Issuer>`
    + `<samlp:NameIDPolicy Format="${NAME_ID_EMAIL}" AllowCreate="true"/></samlp:AuthnRequest>`
}

/** HTTP-Redirect binding: the request deflated (raw), base64, in `SAMLRequest`. */
export async function redirectUrl(ssoUrl: string, request: string): Promise<string> {
  const stream = new Blob([utf8(request) as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const deflated = new Uint8Array(await new Response(stream).arrayBuffer())
  const url = new URL(ssoUrl)
  url.searchParams.set('SAMLRequest', base64(deflated))
  return url.href
}

/** The SP metadata identity providers import: our entity id and ACS, signed assertions wanted, e-mail NameID. */
export function spMetadata(sp: ServiceProvider): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<md:EntityDescriptor xmlns:md="${NS.metadata}" entityID="${escapeXml(sp.entityId)}">`
    + `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="${NS.protocol}">`
    + `<md:NameIDFormat>${NAME_ID_EMAIL}</md:NameIDFormat>`
    + `<md:AssertionConsumerService Binding="${HTTP_POST}" Location="${escapeXml(sp.acsUrl)}" index="0" isDefault="true"/>`
    + '</md:SPSSODescriptor></md:EntityDescriptor>\n'
}

/** PEM certificates, normalized (one per BEGIN/END block, 64-column base64); null when none is usable DER. */
export function parseCertificates(input: string): string[] | null {
  const blocks = [...input.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((match) => match[1]!.replace(/\s+/g, ''))
  if (!blocks.length) return null
  const certificates: string[] = []
  for (const block of blocks) {
    const der = fromBase64(block)
    // A certificate is a DER SEQUENCE; anything else is pasted wrong.
    if (!der || der.length < 100 || der[0] !== 0x30) return null
    certificates.push(`-----BEGIN CERTIFICATE-----\n${block.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`)
  }
  return certificates
}

export interface IdentityProvider {
  entityId: string
  certificates: readonly string[]
}

export interface SamlIdentity {
  /** The AuthnRequest the response answers. */
  inResponseTo: string
  email: string
  name: string | null
  /** Every attribute of the signed assertion, by lower-cased name (the operator console reads `groups`). */
  attributes: Map<string, string[]>
}

function decode(samlResponse: string): string {
  if (samlResponse.length > (MAX_RESPONSE_BYTES * 4) / 3 + 4096) throw malformed('The response is too large')
  const bytes = fromBase64(samlResponse.replace(/\s+/g, ''))
  if (!bytes) throw malformed('The response is not base64')
  if (bytes.length > MAX_RESPONSE_BYTES) throw malformed('The response is too large')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw malformed('The response is not UTF-8')
  }
}

function parseInstant(value: string | null, name: string): number | null {
  if (value === null || value === '') return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value)) throw malformed(`${name} is not a UTC time`)
  const time = Date.parse(value)
  if (Number.isNaN(time)) throw malformed(`${name} is not a valid time`)
  return time
}

/** Signature wrapping relies on two elements answering to one ID: none may. */
function assertUniqueIds(doc: XmlDocument): void {
  const seen = new Set<string>()
  forEachElement(doc, (element) => {
    for (const name of ID_ATTRIBUTES) {
      const value = attribute(element, name)
      if (value === null) continue
      if (seen.has(value)) throw malformed('Two elements share an ID')
      seen.add(value)
    }
  })
}

/** One SignedInfo with one Reference to `#id`, enveloped plus exclusive C14N, and strong algorithms only. */
function assertSignatureProfile(signature: XmlElement, id: string): void {
  structure(() => {
    const counts = new Map<string, number>()
    forEachElement(signature, (element) => counts.set(element.localName, (counts.get(element.localName) ?? 0) + 1))
    for (const name of ['SignedInfo', 'CanonicalizationMethod', 'SignatureMethod', 'Reference', 'SignatureValue']) {
      if (counts.get(name) !== 1) throw malformed(`The signature must have exactly one ${name}`)
    }
    const signedInfo = requiredChild(signature, NS.dsig, 'SignedInfo')
    if (!EXCLUSIVE_C14N.includes(requiredChild(signedInfo, NS.dsig, 'CanonicalizationMethod').getAttribute('Algorithm') ?? '')) {
      throw malformed('Unsupported canonicalization')
    }
    const method = requiredChild(signedInfo, NS.dsig, 'SignatureMethod')
    if (!SIGNATURE_ALGORITHMS.includes(method.getAttribute('Algorithm') ?? '') || allChildElements(method).length) {
      throw malformed('Unsupported signature algorithm (RSA-SHA256 or stronger is required)')
    }
    const reference = requiredChild(signedInfo, NS.dsig, 'Reference')
    if (reference.getAttribute('URI') !== `#${id}`) throw malformed('The signature does not reference the signed element')
    const transforms = childElements(requiredChild(reference, NS.dsig, 'Transforms'), NS.dsig, 'Transform').map((transform) => transform.getAttribute('Algorithm') ?? '')
    if (!transforms.includes(ENVELOPED) || transforms.some((algorithm) => algorithm !== ENVELOPED && !EXCLUSIVE_C14N.includes(algorithm))) {
      throw malformed('Unsupported signature transforms')
    }
    if (!DIGEST_ALGORITHMS.includes(requiredChild(reference, NS.dsig, 'DigestMethod').getAttribute('Algorithm') ?? '')) {
      throw malformed('Unsupported digest (SHA-256 or stronger is required)')
    }
  })
}

/**
 * Checks `signature` over `element` with one of the configured certificates (KeyInfo is ignored) and returns the
 * signed element, re-parsed from the bytes the signature covers. Claims are read only from what this returns.
 */
function verifySigned(xml: string, element: XmlElement, signature: XmlElement, certificates: readonly string[]): XmlElement {
  const id = element.getAttribute('ID')
  if (!id) throw malformed(`The signed ${element.localName} has no ID`)
  assertSignatureProfile(signature, id)
  for (const certificate of certificates) {
    const verifier = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null })
    let valid = false
    try {
      verifier.loadSignature(signature)
      valid = verifier.checkSignature(xml) === true
    } catch {
      valid = false
    }
    if (!valid) continue
    const references = verifier.getSignedReferences()
    if (references.length !== 1) throw malformed('Expected exactly one signed reference')
    const signed = parseXml(references[0]!).documentElement
    if (!signed || signed.namespaceURI !== element.namespaceURI || signed.localName !== element.localName || signed.getAttribute('ID') !== id) {
      throw malformed('The signed content is not the referenced element')
    }
    return signed
  }
  throw new SamlError('invalid_signature', 'The response is not signed with the identity provider\'s certificate')
}

function attributesOf(assertion: XmlElement): Map<string, string[]> {
  const attributes = new Map<string, string[]>()
  for (const statement of childElements(assertion, NS.assertion, 'AttributeStatement')) {
    for (const item of childElements(statement, NS.assertion, 'Attribute')) {
      const name = (item.getAttribute('Name') ?? '').toLowerCase()
      if (!name) continue
      attributes.set(name, [...(attributes.get(name) ?? []), ...childElements(item, NS.assertion, 'AttributeValue').map(simpleText)])
    }
  }
  return attributes
}

function first(attributes: Map<string, string[]>, names: string[]): string | null {
  for (const name of names) {
    const value = attributes.get(name)?.find((candidate) => candidate.trim())
    if (value) return value.trim()
  }
  return null
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Checks a SAML response for SP-initiated sign-in; throws SamlError on anything wrong. */
export function validateResponse(options: { samlResponse: string; idp: IdentityProvider; sp: ServiceProvider; now: number }): SamlIdentity {
  const { idp, sp, now } = options
  const xml = decode(options.samlResponse)
  const doc = parseXml(xml)
  const response = doc.documentElement
  if (!isElement(response, NS.protocol, 'Response') || response.getAttribute('Version') !== '2.0') throw malformed('Expected a SAML 2.0 Response')
  if (!attribute(response, 'InResponseTo')) throw new SamlError('unsolicited', 'Sign-ins started at the identity provider aren\'t accepted')

  const status = structure(() => requiredChild(requiredChild(response, NS.protocol, 'Status'), NS.protocol, 'StatusCode'))
  if (status.getAttribute('Value') !== STATUS_SUCCESS) throw new SamlError('idp_status', 'The identity provider didn\'t sign you in')
  if (doc.getElementsByTagNameNS(NS.assertion, 'EncryptedAssertion').length) throw malformed('Encrypted assertions aren\'t supported')
  const assertions = doc.getElementsByTagNameNS(NS.assertion, 'Assertion')
  const assertion = assertions.length === 1 ? assertions.item(0) : null
  if (!assertion || assertion.parentNode !== response) throw malformed('Expected exactly one Assertion, directly in the Response')
  assertUniqueIds(doc)

  // Only the Response and the Assertion may be signed, each at most once, and nothing else may carry a signature.
  const responseSignature = structure(() => optionalChild(response, NS.dsig, 'Signature'))
  const assertionSignature = structure(() => optionalChild(assertion, NS.dsig, 'Signature'))
  if (doc.getElementsByTagNameNS(NS.dsig, 'Signature').length !== Number(responseSignature !== null) + Number(assertionSignature !== null)) {
    throw malformed('Unexpected Signature element')
  }
  let signedAssertion: XmlElement
  let signedResponse: XmlElement | null = null
  if (assertionSignature) {
    signedAssertion = verifySigned(xml, assertion, assertionSignature, idp.certificates)
  } else if (responseSignature) {
    signedResponse = verifySigned(xml, response, responseSignature, idp.certificates)
    const inner = childElements(signedResponse, NS.assertion, 'Assertion')
    if (inner.length !== 1) throw malformed('The signed response must hold exactly one Assertion')
    signedAssertion = inner[0]!
  } else {
    throw new SamlError('unsigned', 'The response isn\'t signed')
  }

  return structure(() => {
    // The envelope is read from the signed copy when the whole response is signed.
    const envelope = signedResponse ?? response
    const destination = attribute(envelope, 'Destination')
    if (destination !== null && destination !== sp.acsUrl) throw new SamlError('wrong_destination', 'The response is for another service')
    const responseIssuer = optionalChild(envelope, NS.assertion, 'Issuer')
    if (responseIssuer && simpleText(responseIssuer) !== idp.entityId) throw new SamlError('wrong_issuer', 'The response comes from another identity provider')
    if (signedAssertion.getAttribute('Version') !== '2.0') throw malformed('Expected a SAML 2.0 Assertion')
    if (simpleText(requiredChild(signedAssertion, NS.assertion, 'Issuer')) !== idp.entityId) {
      throw new SamlError('wrong_issuer', 'The assertion comes from another identity provider')
    }

    const subject = requiredChild(signedAssertion, NS.assertion, 'Subject')
    let inResponseTo: string | null = null
    let refusal = new SamlError('malformed', 'No bearer subject confirmation')
    for (const confirmation of childElements(subject, NS.assertion, 'SubjectConfirmation')) {
      if (confirmation.getAttribute('Method') !== BEARER) continue
      const data = optionalChild(confirmation, NS.assertion, 'SubjectConfirmationData')
      if (!data) continue
      if (attribute(data, 'Recipient') !== sp.acsUrl) {
        refusal = new SamlError('wrong_recipient', 'The assertion is for another service')
        continue
      }
      const notOnOrAfter = parseInstant(attribute(data, 'NotOnOrAfter'), 'NotOnOrAfter')
      const notBefore = parseInstant(attribute(data, 'NotBefore'), 'NotBefore')
      if (notOnOrAfter === null || now - CLOCK_SKEW_MS >= notOnOrAfter || (notBefore !== null && now + CLOCK_SKEW_MS < notBefore)) {
        refusal = new SamlError('expired', 'The sign-in has expired')
        continue
      }
      const requestId = attribute(data, 'InResponseTo')
      if (!requestId) {
        refusal = new SamlError('unsolicited', 'The assertion doesn\'t answer a sign-in we started')
        continue
      }
      inResponseTo = requestId
      break
    }
    if (inResponseTo === null) throw refusal
    if (attribute(envelope, 'InResponseTo') !== inResponseTo) throw malformed('The response and the assertion answer different requests')

    const conditions = requiredChild(signedAssertion, NS.assertion, 'Conditions')
    const notBefore = parseInstant(attribute(conditions, 'NotBefore'), 'Conditions NotBefore')
    const notOnOrAfter = parseInstant(attribute(conditions, 'NotOnOrAfter'), 'Conditions NotOnOrAfter')
    if ((notBefore !== null && now + CLOCK_SKEW_MS < notBefore) || (notOnOrAfter !== null && now - CLOCK_SKEW_MS >= notOnOrAfter)) {
      throw new SamlError('expired', 'The sign-in is outside its validity window')
    }
    const restrictions = childElements(conditions, NS.assertion, 'AudienceRestriction')
    if (!restrictions.length || restrictions.some((restriction) => !childElements(restriction, NS.assertion, 'Audience').some((audience) => simpleText(audience) === sp.entityId))) {
      throw new SamlError('wrong_audience', 'The assertion is for another service')
    }
    if (!childElements(signedAssertion, NS.assertion, 'AuthnStatement').length) throw malformed('Missing AuthnStatement')

    const attributes = attributesOf(signedAssertion)
    const nameId = requiredChild(subject, NS.assertion, 'NameID')
    const format = attribute(nameId, 'Format')
    const subjectText = simpleText(nameId)
    const fromNameId = (format === null || format === NAME_ID_EMAIL || format === NAME_ID_UNSPECIFIED) && EMAIL_SHAPE.test(subjectText) ? subjectText : null
    const email = fromNameId ?? first(attributes, EMAIL_ATTRIBUTES)
    if (!email || !EMAIL_SHAPE.test(email)) throw new SamlError('no_email', 'The identity provider didn\'t send an e-mail address')
    const given = first(attributes, GIVEN_NAME_ATTRIBUTES)
    const surname = first(attributes, SURNAME_ATTRIBUTES)
    const name = first(attributes, NAME_ATTRIBUTES) ?? ([given, surname].filter(Boolean).join(' ') || null)
    return { inResponseTo, email, name, attributes }
  })
}
