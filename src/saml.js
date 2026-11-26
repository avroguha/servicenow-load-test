'use strict';
// SAML 2.0 for the mock identity provider: read ServiceNow's AuthnRequest and
// answer with a signed Response.
//
// The XML is written directly in its canonical form (exclusive C14N): no
// whitespace between elements, attributes in sorted order, a namespace declared
// on the first element that uses it, no self-closing tags. That is what lets
// the signature be computed with node:crypto alone, with no XML library.
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const NS_A = 'urn:oasis:names:tc:SAML:2.0:assertion';
const NS_P = 'urn:oasis:names:tc:SAML:2.0:protocol';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\r/g, '&#xD;');
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const newId = () => `_${crypto.randomBytes(16).toString('hex')}`;

// Reads the two values needed from an AuthnRequest. `encoded` is the
// SAMLRequest parameter: deflated + base64 on the redirect binding, plain base64
// on the POST binding.
function parseAuthnRequest(encoded) {
  const raw = Buffer.from(String(encoded || ''), 'base64');
  let xml;
  try { xml = zlib.inflateRawSync(raw).toString('utf8'); } catch { xml = raw.toString('utf8'); }
  const open = (xml.match(/<(?:[\w-]+:)?AuthnRequest\b[^>]*>/) || [''])[0];
  if (!open) throw new Error('not a SAML AuthnRequest');
  const attr = (n) => { const m = open.match(new RegExp(`\\b${n}="([^"]*)"`)); return m ? unesc(m[1]) : ''; };
  const issuer = (xml.match(/<(?:[\w-]+:)?Issuer\b[^>]*>([^<]*)</) || [])[1] || '';
  return { id: attr('ID'), acsUrl: attr('AssertionConsumerServiceURL'), destination: attr('Destination'), issuer: unesc(issuer.trim()) };
}
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// Enveloped signature over one element. `before` and `after` are the two halves
// of the element's canonical XML around the place the Signature goes (right
// after its Issuer).
function signElement(before, after, id, key, certB64) {
  const digest = crypto.createHash('sha256').update(before + after, 'utf8').digest('base64');
  const info = (withNs) => `<ds:SignedInfo${withNs ? ` xmlns:ds="${NS_DS}"` : ''}>`
    + `<ds:CanonicalizationMethod Algorithm="${C14N}"></ds:CanonicalizationMethod>`
    + '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>'
    + `<ds:Reference URI="#${id}"><ds:Transforms>`
    + '<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>'
    + `<ds:Transform Algorithm="${C14N}"></ds:Transform></ds:Transforms>`
    + '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>'
    + `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const value = crypto.sign('sha256', Buffer.from(info(true), 'utf8'), key).toString('base64');
  return `${before}<ds:Signature xmlns:ds="${NS_DS}">${info(false)}`
    + `<ds:SignatureValue>${value}</ds:SignatureValue>`
    + `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`
    + `</ds:Signature>${after}`;
}

// o: idpEntityId, audience, acsUrl, inResponseTo, nameId, nameIdFormat,
//    attributes {name: value}, key, certB64, signResponse, now, lifetimeSec
function buildResponse(o) {
  const now = o.now || Date.now();
  const life = (o.lifetimeSec || 300) * 1000;
  const aId = newId();
  const rId = newId();
  const irt = o.inResponseTo ? `InResponseTo="${esc(o.inResponseTo)}" ` : '';
  const issuer = `<saml2:Issuer xmlns:saml2="${NS_A}">${esc(o.idpEntityId)}</saml2:Issuer>`;
  const attrs = Object.entries(o.attributes || {}).map(([k, v]) => `<saml2:Attribute Name="${esc(k)}">`
    + `<saml2:AttributeValue>${esc(v)}</saml2:AttributeValue></saml2:Attribute>`).join('');
  const aBefore = `<saml2:Assertion xmlns:saml2="${NS_A}" ID="${aId}" IssueInstant="${stamp(now)}" Version="2.0">`
    + `<saml2:Issuer>${esc(o.idpEntityId)}</saml2:Issuer>`;
  const aAfter = '<saml2:Subject>'
    + `<saml2:NameID Format="${esc(o.nameIdFormat)}">${esc(o.nameId)}</saml2:NameID>`
    + '<saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
    + `<saml2:SubjectConfirmationData ${irt}NotOnOrAfter="${stamp(now + life)}" Recipient="${esc(o.acsUrl)}"></saml2:SubjectConfirmationData>`
    + '</saml2:SubjectConfirmation></saml2:Subject>'
    + `<saml2:Conditions NotBefore="${stamp(now - 60000)}" NotOnOrAfter="${stamp(now + life)}">`
    + `<saml2:AudienceRestriction><saml2:Audience>${esc(o.audience)}</saml2:Audience></saml2:AudienceRestriction></saml2:Conditions>`
    + `<saml2:AuthnStatement AuthnInstant="${stamp(now)}" SessionIndex="${aId}"><saml2:AuthnContext>`
    + '<saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml2:AuthnContextClassRef>'
    + '</saml2:AuthnContext></saml2:AuthnStatement>'
    + (attrs ? `<saml2:AttributeStatement>${attrs}</saml2:AttributeStatement>` : '')
    + '</saml2:Assertion>';
  const assertion = signElement(aBefore, aAfter, aId, o.key, o.certB64);
  const rBefore = `<saml2p:Response xmlns:saml2p="${NS_P}" Destination="${esc(o.acsUrl)}" ID="${rId}" ${irt}`
    + `IssueInstant="${stamp(now)}" Version="2.0">${issuer}`;
  const rAfter = '<saml2p:Status><saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"></saml2p:StatusCode></saml2p:Status>'
    + `${assertion}</saml2p:Response>`;
  const xml = o.signResponse ? signElement(rBefore, rAfter, rId, o.key, o.certB64) : rBefore + rAfter;
  return { xml, b64: Buffer.from(xml, 'utf8').toString('base64'), assertionId: aId, responseId: rId };
}

// The page the browser gets from the identity provider: a form that posts the
// answer to ServiceNow by itself, the way a real identity provider does.
function postForm(acsUrl, samlResponseB64, relayState) {
  const relay = relayState ? `<input type="hidden" name="RelayState" value="${esc(relayState)}">` : '';
  return '<!doctype html><html><head><meta charset="utf-8"><title>Signing in</title></head>'
    + `<body onload="document.forms[0].submit()"><form method="post" action="${esc(acsUrl)}">`
    + `<input type="hidden" name="SAMLResponse" value="${samlResponseB64}">${relay}`
    + '<noscript><button type="submit">Continue</button></noscript></form></body></html>';
}

module.exports = { parseAuthnRequest, buildResponse, postForm, signElement, esc };
