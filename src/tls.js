'use strict';
// The app's HTTPS certificate: <certs>/tls.crt (server certificate first, then
// its intermediates, PEM) and <certs>/tls.key (private key without a password).
//
//  - No certificate at first start: a self-signed one is made, so the app
//    always comes up on HTTPS. A certificate that is already there is never
//    touched.
//  - A new pair dropped in (scripts/install-cert.sh) is picked up within a
//    minute without a restart. If the new pair is unusable the old one keeps
//    serving and the reason is logged.
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { selfSigned } = require('./x509');

const files = (dir) => ({ crt: path.join(dir, 'tls.crt'), key: path.join(dir, 'tls.key') });

function ensure(dir, names, log = console.log) {
  const f = files(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(f.crt) && fs.existsSync(f.key)) return false;
  if (fs.existsSync(f.crt) || fs.existsSync(f.key)) throw new Error(`${dir} holds only one of tls.crt and tls.key. Put both there (scripts/install-cert.sh), or remove the one that is there.`);
  const list = [...new Set(['localhost', '127.0.0.1', ...names.filter(Boolean)])];
  const c = selfSigned({ commonName: list.find((n) => !['localhost', '127.0.0.1'].includes(n)) || 'localhost', days: 825, names: list });
  fs.writeFileSync(f.key, c.keyPem, { mode: 0o600 });
  fs.writeFileSync(f.crt, c.certPem, { mode: 0o644 });
  log(`tls: no certificate in ${dir}; made a self-signed one for ${list.join(', ')}. Browsers will warn until a real one is installed (scripts/install-cert.sh).`);
  return true;
}

function read(dir) {
  const f = files(dir);
  const cert = fs.readFileSync(f.crt);
  const key = fs.readFileSync(f.key);
  tls.createSecureContext({ cert, key });               // throws when the pair is unusable
  const x = new crypto.X509Certificate(cert);
  if (!x.checkPrivateKey(crypto.createPrivateKey(key))) throw new Error('tls.key does not belong to the certificate in tls.crt');
  return { cert, key, subject: x.subject.replace(/\n/g, ', '), validTo: x.validTo, stamp: `${fs.statSync(f.crt).mtimeMs}:${fs.statSync(f.key).mtimeMs}` };
}

// Re-reads the pair when its files change, at most once a minute.
function watch(dir, server, first, log = console.log, everyMs = 60000) {
  let stamp = first.stamp;
  let complained = '';
  const t = setInterval(() => {
    const f = files(dir);
    let now;
    try { now = `${fs.statSync(f.crt).mtimeMs}:${fs.statSync(f.key).mtimeMs}`; } catch { return; }   // mid-replacement
    if (now === stamp) return;
    try {
      const next = read(dir);
      server.setSecureContext({ cert: next.cert, key: next.key });
      stamp = next.stamp; complained = '';
      log(`tls: new certificate in use: ${next.subject}, valid to ${next.validTo}`);
    } catch (err) {
      if (complained !== now) { complained = now; log(`tls: the new certificate cannot be used (${err.message}); still serving the previous one`); }
    }
  }, everyMs);
  t.unref();
  return t;
}

module.exports = { ensure, read, watch };
