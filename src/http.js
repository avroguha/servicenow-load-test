'use strict';
// One HTTP request, directly or through a forward proxy.
//
// Not every instance can be reached straight from where this app runs, so the
// admin connection and each test can name a proxy. Direct requests use fetch;
// proxied ones go through a CONNECT tunnel (HTTPS targets) or an absolute-URL
// request (HTTP targets), with node's own http/https modules - no package.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const agents = new Map();           // proxy URL -> tunnelling agent, connections kept open

function proxyAuth(p) {
  return p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {};
}

class TunnelAgent extends https.Agent {
  constructor(proxyUrl, insecure) { super({ keepAlive: true, maxSockets: 256 }); this.proxy = new URL(proxyUrl); this.insecure = insecure; }

  createConnection(opts, cb) {
    const p = this.proxy;
    const target = `${opts.host}:${opts.port || 443}`;
    const req = (p.protocol === 'https:' ? https : http).request({
      host: p.hostname, port: p.port || (p.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: target,
      headers: { Host: target, ...proxyAuth(p) }, timeout: 30000,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); cb(new Error(`the proxy ${p.host} refused the connection (HTTP ${res.statusCode})`)); return; }
      cb(null, tls.connect({ socket, servername: opts.servername || opts.host, rejectUnauthorized: !this.insecure }));
    });
    req.once('timeout', () => req.destroy(new Error(`the proxy ${p.host} did not answer`)));
    req.once('error', (err) => cb(new Error(`cannot reach the proxy ${p.host}: ${err.message}`)));
    req.end();
  }
}

function viaProxy({ method, url, headers, body, timeoutMs, proxy, insecure }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const p = new URL(proxy);
    let opts;
    let mod;
    if (u.protocol === 'https:') {
      const key = `${proxy}|${insecure ? 1 : 0}`;
      if (!agents.has(key)) agents.set(key, new TunnelAgent(proxy, insecure));
      mod = https;
      opts = { host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, agent: agents.get(key) };
    } else {
      mod = p.protocol === 'https:' ? https : http;
      opts = { host: p.hostname, port: p.port || 80, path: url, method, headers: { Host: u.host, ...proxyAuth(p), ...headers } };
    }
    const req = mod.request(opts, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { const e = new Error('no answer within the time limit'); e.name = 'TimeoutError'; req.destroy(e); });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// -> { status, headers, text }. Redirects are not followed.
async function request({ method = 'GET', url, headers = {}, body, timeoutMs = 60000, proxy = '', insecure = false }) {
  if (proxy) return viaProxy({ method, url, headers, body, timeoutMs, proxy, insecure });
  const r = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() };
}

// What an administrator typed as a proxy: '' when it is not a usable address.
function cleanProxy(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  try { const u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `http://${v}`); return ['http:', 'https:'].includes(u.protocol) && u.hostname ? u.href.replace(/\/$/, '') : ''; } catch { return ''; }
}
// The address without its password, for showing on a page.
function maskProxy(value) { try { const u = new URL(value); if (u.password) u.password = '****'; return u.href.replace(/\/$/, ''); } catch { return ''; } }
// Which proxy a name means. '' and 'direct' mean none; '(connection)' means the one the admin connection uses.
function resolveProxy(settings, name) {
  const pick = name === '(connection)' || name == null ? settings.connectionProxy : name;
  if (!pick || pick === 'direct') return '';
  const p = (settings.proxies || []).find((x) => x.name === pick);
  return p ? p.url : '';
}

module.exports = { request, cleanProxy, maskProxy, resolveProxy };
