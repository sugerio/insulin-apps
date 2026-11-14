// A stand-in SAML identity provider for the tests: an RSA key with a self-signed certificate (built here, since Node
// can't make one), responses shaped like a real provider's, and xml-crypto to sign them. All data is synthetic.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { SignedXml } from 'xml-crypto'

function length(size) {
  if (size < 0x80) return Buffer.from([size])
  const bytes = []
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, ...parts) => {
  const content = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), length(content.length), content])
}
const sequence = (...parts) => tlv(0x30, ...parts)
const set = (...parts) => tlv(0x31, ...parts)
function oid(text) {
  const [first, second, ...rest] = text.split('.').map(Number)
  const bytes = [first * 40 + second]
  for (const value of rest) {
    const chunk = []
    let remaining = value
    do { chunk.unshift(remaining & 0x7f); remaining >>= 7 } while (remaining > 0)
    bytes.push(...chunk.map((byte, index) => (index < chunk.length - 1 ? byte | 0x80 : byte)))
  }
  return tlv(0x06, Buffer.from(bytes))
}
const utcTime = (date) => tlv(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`))
const name = (commonName) => sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))))

/** An RSA key and a self-signed (X.509 v1) certificate for it, both PEM. */
export function makeIdentityProviderKey(commonName = 'Test IdP') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const algorithm = sequence(oid('1.2.840.113549.1.1.11'), tlv(0x05))
  const tbs = sequence(
    tlv(0x02, Buffer.from([0x01, ...randomBytes(8)])),
    algorithm,
    name(commonName),
    sequence(utcTime(new Date(Date.now() - 86_400_000)), utcTime(new Date(Date.now() + 365 * 86_400_000))),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
  )
  const signature = sign('sha256', tbs, privateKey)
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature))
  const certificate = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
  return { certificate, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

/** The AuthnRequest id in a redirect URL to the identity provider (HTTP-Redirect binding: deflate-raw, base64). */
export function requestIdFrom(redirectUrl) {
  const xml = inflateRawSync(Buffer.from(new URL(redirectUrl).searchParams.get('SAMLRequest'), 'base64')).toString('utf8')
  return { id: /\bID="([^"]+)"/.exec(xml)[1], xml }
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * A Response with one Assertion, unsigned. Every field can be overridden to make it wrong in one way; `attributes` adds
 * attributes ({ name: [values] }), such as the group membership Google Workspace sends.
 */
export function samlResponse(options) {
  const now = Date.now()
  const o = {
    issuer: 'https://idp.example.test/saml', email: 'sam@sso.example.test', displayName: 'Sam Example', notBefore: now - 60_000,
    notOnOrAfter: now + 300_000, responseId: `_r${randomBytes(8).toString('hex')}`, assertionId: `_a${randomBytes(8).toString('hex')}`,
    status: 'urn:oasis:names:tc:SAML:2.0:status:Success', ...options,
  }
  o.recipient ??= o.acs
  o.destination ??= o.acs
  o.audience ??= o.entityId
  o.assertionInResponseTo ??= o.requestId
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${o.responseId}" Version="2.0" IssueInstant="${iso(now)}" Destination="${o.destination}" InResponseTo="${o.requestId}">`
    + `<saml:Issuer>${o.issuer}</saml:Issuer>`
    + `<samlp:Status><samlp:StatusCode Value="${o.status}"/></samlp:Status>`
    + `<saml:Assertion ID="${o.assertionId}" Version="2.0" IssueInstant="${iso(now)}">`
    + `<saml:Issuer>${o.issuer}</saml:Issuer>`
    + '<saml:Subject>'
    + `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.assertionInResponseTo}" NotOnOrAfter="${iso(o.notOnOrAfter)}" Recipient="${o.recipient}"/></saml:SubjectConfirmation>`
    + '</saml:Subject>'
    + `<saml:Conditions NotBefore="${iso(o.notBefore)}" NotOnOrAfter="${iso(o.notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(now)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>${o.displayName}</saml:AttributeValue></saml:Attribute>`
    + Object.entries(o.attributes ?? {}).map(([attribute, values]) => `<saml:Attribute Name="${attribute}">${values.map((value) => `<saml:AttributeValue>${value}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('')
    + '</saml:AttributeStatement>'
    + '</saml:Assertion></samlp:Response>'
}

/** Signs the Assertion (the usual case) or the whole Response, RSA-SHA256 with exclusive C14N, as providers do. */
export function signResponse(xml, key, { element = 'Assertion' } = {}) {
  const signer = new SignedXml({ privateKey: key.privateKey, publicCert: key.certificate })
  signer.addReference({
    xpath: `//*[local-name(.)='${element}']`,
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  })
  signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#'
  signer.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
  signer.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='Issuer' and parent::*[local-name(.)='${element}']]`, action: 'after' },
  })
  return signer.getSignedXml()
}

export const encode = (xml) => Buffer.from(xml, 'utf8').toString('base64')
