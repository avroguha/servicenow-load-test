'use strict';
// A self-signed X.509 certificate, written by hand in DER so the mock identity
// provider needs no openssl and no package. One key pair and certificate is made
// per test run, lives in memory only, and is removed from the instance at stop.
const crypto = require('node:crypto');

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function utcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}
const OID_SHA256_RSA = Buffer.from('06092a864886f70d01010b', 'hex');
const OID_CN = Buffer.from('0603550403', 'hex');
const NULL = Buffer.from('0500', 'hex');

function selfSigned({ commonName, days = 2, now = new Date() }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = seq(OID_SHA256_RSA, NULL);
  const name = seq(set(seq(OID_CN, tlv(0x0c, Buffer.from(commonName, 'utf8')))));
  const notBefore = new Date(now.getTime() - 3600e3);
  const notAfter = new Date(now.getTime() + days * 86400e3);
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),                 // version 3
    int(crypto.randomBytes(12)),
    alg, name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, alg, tlv(0x03, Buffer.from([0]), sig));
  const b64 = der.toString('base64');
  const pem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { privateKey, certPem: pem, certB64: b64, notAfter };
}

module.exports = { selfSigned };
