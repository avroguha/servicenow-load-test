'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const saml = require('../src/saml');
const idp = require('../src/idp');
const { selfSigned } = require('../src/x509');

const cert = selfSigned({ commonName: 'unit test' });
const opts = (extra = {}) => ({
  idpEntityId: 'urn:uiload:t', audience: 'https://x.example', acsUrl: 'https://x.example/navpage.do', inResponseTo: '_req1',
  nameId: 'lt.user.001', nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', key: cert.privateKey, certB64: cert.certB64, ...extra,
});

// Checks one enveloped signature the way a service provider does: the digest
// of the element without its Signature, then the signature over SignedInfo.
function verify(xml, tag) {
  const el = xml.match(new RegExp(`<${tag}\\b[\\s\\S]*</${tag}>`))[0];
  const sig = el.match(/<ds:Signature\b[\s\S]*?<\/ds:Signature>/)[0];
  const digest = sig.match(/<ds:DigestValue>([^<]+)</)[1];
  const value = sig.match(/<ds:SignatureValue>([^<]+)</)[1];
  const info = sig.match(/<ds:SignedInfo>[\s\S]*<\/ds:SignedInfo>/)[0].replace('<ds:SignedInfo>', '<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">');
  const digestOk = crypto.createHash('sha256').update(el.replace(sig, '')).digest('base64') === digest;
  const pub = new crypto.X509Certificate(cert.certPem).publicKey;
  return digestOk && crypto.verify('sha256', Buffer.from(info), pub, Buffer.from(value, 'base64'));
}

test('the certificate is a valid self-signed X.509 certificate', () => {
  const x = new crypto.X509Certificate(cert.certPem);
  assert.ok(x.verify(x.publicKey));
  assert.match(x.subject, /CN=unit test/);
  assert.ok(new Date(x.validTo) > new Date());
});

test('the assertion signature verifies, and a changed user name breaks it', () => {
  const r = saml.buildResponse(opts());
  assert.ok(verify(r.xml, 'saml2:Assertion'));
  assert.ok(!verify(r.xml.replace('lt.user.001', 'admin'), 'saml2:Assertion'));
  assert.match(r.xml, /InResponseTo="_req1"/);
  assert.match(r.xml, /<saml2:Audience>https:\/\/x\.example<\/saml2:Audience>/);
});

test('with the response signed too, the assertion keeps its own valid signature', () => {
  const r = saml.buildResponse(opts({ signResponse: true }));
  const a = r.xml.match(/<saml2:Assertion\b[\s\S]*<\/saml2:Assertion>/)[0];
  assert.ok(verify(a, 'saml2:Assertion'));
  assert.strictEqual(r.xml.match(/<ds:Signature /g).length, 2);
});

test('text is escaped, so a value cannot add XML', () => {
  const r = saml.buildResponse(opts({ nameId: 'a<b>&"c', attributes: { 'x"y': '<z>' } }));
  assert.ok(r.xml.includes('a&lt;b&gt;&amp;&quot;c'));
  assert.ok(!r.xml.includes('<z>'));
  assert.ok(verify(r.xml, 'saml2:Assertion'));
});

const authn = (issuer) => `<p:AuthnRequest xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" AssertionConsumerServiceURL="https://x.example/navpage.do" ID="R1" Version="2.0"><a:Issuer xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</a:Issuer></p:AuthnRequest>`;

test('an AuthnRequest is read from both bindings', () => {
  const xml = authn('https://x.example');
  for (const enc of [zlib.deflateRawSync(xml).toString('base64'), Buffer.from(xml).toString('base64')]) {
    assert.deepStrictEqual(saml.parseAuthnRequest(enc), { id: 'R1', acsUrl: 'https://x.example/navpage.do', destination: '', issuer: 'https://x.example' });
  }
  assert.throws(() => saml.parseAuthnRequest(Buffer.from('<html/>').toString('base64')));
});

// ---- the mock identity provider --------------------------------------------
const sso = { id: 'abc', entityId: 'urn:uiload:r1', key: cert.privateKey, certB64: cert.certB64, audience: 'https://x.example', acsUrl: 'https://x.example/navpage.do' };
const request = (issuer = 'https://x.example') => new URLSearchParams({ SAMLRequest: zlib.deflateRawSync(authn(issuer)).toString('base64'), RelayState: 'https://x.example/home' });
function call(cookie, params = request()) {
  const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  idp.handleSso({ headers: { cookie } }, res, params);
  return res;
}

test('with no run active the identity provider refuses everyone', () => {
  idp.close();
  assert.strictEqual(call('uiload_idp=x.1.y').code, 403);
  assert.throws(() => idp.ticket('lt.user.001'));
});

test('only the run\'s own users get an answer, and only towards the instance under test', () => {
  idp.open({ runId: 'r1', sso, userNames: ['lt.user.001', 'lt.user.002'] });
  const ok = call(`other=1; uiload_idp=${idp.ticket('lt.user.001')}`);
  assert.strictEqual(ok.code, 200);
  assert.match(ok.body, /action="https:\/\/x\.example\/navpage\.do"/);
  assert.match(ok.body, /name="RelayState" value="https:\/\/x\.example\/home"/);
  const xml = Buffer.from(ok.body.match(/name="SAMLResponse" value="([^"]+)"/)[1], 'base64').toString();
  assert.match(xml, />lt\.user\.001<\/saml2:NameID>/);
  assert.match(xml, /InResponseTo="R1"/);
  assert.ok(verify(xml, 'saml2:Assertion'));

  assert.strictEqual(call('').code, 403, 'no ticket');
  assert.strictEqual(idp.readTicket(idp.ticket('admin')), null, 'a user outside the run');
  const t = idp.ticket('lt.user.001');
  assert.strictEqual(idp.readTicket(t.replace(/^[^.]+/, Buffer.from('admin').toString('base64url'))), null, 'a changed name');
  assert.strictEqual(idp.readTicket(idp.ticket('lt.user.001', -5)), null, 'an expired ticket');
  assert.strictEqual(call(`uiload_idp=${t}`, request('https://evil.example')).code, 403, 'a request from another site');
  assert.deepStrictEqual(idp.stats(), { issued: 1, refused: 2 });
});

test('a ticket from one run is worthless in the next', () => {
  idp.open({ runId: 'r1', sso, userNames: ['lt.user.001'] });
  const old = idp.ticket('lt.user.001');
  idp.open({ runId: 'r2', sso, userNames: ['lt.user.001'] });
  assert.strictEqual(idp.readTicket(old), null);
  idp.close();
});
