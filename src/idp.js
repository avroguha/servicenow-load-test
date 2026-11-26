'use strict';
// The mock identity provider. It exists only while a run is active and signs
// in only that run's temporary users:
//  - the signing key is made for the run, kept in memory, never written down;
//  - a browser must carry a ticket (a cookie the worker sets) naming one of the
//    run's users, signed with the run's secret;
//  - the answer is posted only to the instance the run is testing.
// Anyone else who reaches /idp/sso gets a refusal, and ServiceNow never sends
// anyone else here, because only the temporary users' sso_source names it.
const crypto = require('node:crypto');
const saml = require('./saml');

const COOKIE = 'uiload_idp';
let realm = null;

function open({ runId, sso, userNames }) {
  realm = { runId, ...sso, users: new Set(userNames), secret: crypto.randomBytes(32), issued: 0, refused: 0 };
}
function close() { realm = null; }
function stats() { return realm ? { issued: realm.issued, refused: realm.refused } : null; }

function ticket(userName, ttlSec = 24 * 3600) {
  if (!realm) throw new Error('no run is active');
  const body = `${Buffer.from(userName).toString('base64url')}.${Math.floor(Date.now() / 1000) + ttlSec}`;
  return `${body}.${crypto.createHmac('sha256', realm.secret).update(body).digest('base64url')}`;
}
function readTicket(value) {
  if (!realm || !value) return null;
  const [u, exp, sig] = String(value).split('.');
  if (!u || !exp || !sig) return null;
  const want = crypto.createHmac('sha256', realm.secret).update(`${u}.${exp}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const name = Buffer.from(u, 'base64url').toString();
  return realm.users.has(name) ? name : null;
}

function refuse(res, why) {
  if (realm) realm.refused += 1;
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><title>Sign-in refused</title><body style="font:16px sans-serif;margin:3em"><h2>Test identity provider: sign-in refused</h2><p>${saml.esc(why)}</p></body>`);
}

// params: URLSearchParams from the query string (redirect binding) or form body (POST binding).
function handleSso(req, res, params) {
  if (!realm) return refuse(res, 'No load test is running. This identity provider only answers during a run.');
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  const user = readTicket(cookie && cookie.slice(COOKIE.length + 1));
  if (!user) return refuse(res, 'This browser does not carry a valid ticket for one of the run\'s temporary users.');
  let ar;
  try { ar = saml.parseAuthnRequest(params.get('SAMLRequest')); } catch (err) { return refuse(res, `Bad request: ${err.message}`); }
  if (ar.issuer && ar.issuer !== realm.audience) return refuse(res, `The request comes from ${ar.issuer}, not from the instance under test.`);
  const r = saml.buildResponse({
    idpEntityId: realm.entityId, audience: realm.audience, acsUrl: realm.acsUrl, inResponseTo: ar.id,
    nameId: user, nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    key: realm.key, certB64: realm.certB64,
  });
  realm.issued += 1;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(saml.postForm(realm.acsUrl, r.b64, params.get('RelayState')));
  return undefined;
}

function handleLogout(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Signed out</title><body style="font:16px sans-serif;margin:3em">Signed out of the test identity provider.</body>');
}

module.exports = { open, close, stats, ticket, readTicket, handleSso, handleLogout, COOKIE };
