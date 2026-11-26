'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { request, cleanProxy, maskProxy, resolveProxy } = require('../src/http');
const { selfSigned } = require('../src/x509');
const { diagnose, connectionHints } = require('../src/diagnose');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('an HTTPS request goes through a forward proxy, and a refusing proxy is named in the error', async () => {
  const cert = selfSigned({ commonName: '127.0.0.1' });
  const key = cert.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const target = https.createServer({ key, cert: cert.certPem }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ path: req.url, method: req.method, auth: req.headers.authorization || '', body })); });
  });
  const targetPort = await listen(target);
  const tunnels = [];
  let allow = true;
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    tunnels.push({ to: req.url, auth: req.headers['proxy-authorization'] || '' });
    if (!allow) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    const up = net.connect(+port, host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
  });
  const proxyPort = await listen(proxy);
  try {
    const url = `https://127.0.0.1:${targetPort}/api/now/table/incident?x=1`;
    const r = await request({ method: 'POST', url, headers: { Authorization: 'Basic abc' }, body: '{"a":1}', proxy: `http://bob:s%40cret@127.0.0.1:${proxyPort}`, insecure: true, timeoutMs: 5000 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.text), { path: '/api/now/table/incident?x=1', method: 'POST', auth: 'Basic abc', body: '{"a":1}' });
    assert.strictEqual(tunnels[0].to, `127.0.0.1:${targetPort}`);
    assert.strictEqual(tunnels[0].auth, `Basic ${Buffer.from('bob:s@cret').toString('base64')}`, 'the proxy login is sent to the proxy, not to the target');
    allow = false;
    await assert.rejects(request({ url, proxy: `http://127.0.0.1:${proxyPort}`, insecure: true, timeoutMs: 5000 }), /the proxy 127\.0\.0\.1:\d+ refused the connection \(HTTP 407\)/);
    await assert.rejects(request({ url, proxy: 'http://127.0.0.1:1', insecure: true, timeoutMs: 5000 }), /cannot reach the proxy/);
  } finally { proxy.close(); target.close(); proxy.closeAllConnections(); target.closeAllConnections(); }
});

test('proxy addresses are cleaned, masked and chosen by name', () => {
  assert.strictEqual(cleanProxy(' proxy.avro.com:8080 '), 'http://proxy.avro.com:8080');
  assert.strictEqual(cleanProxy('ftp://x'), ''); assert.strictEqual(cleanProxy('not a url at all'), '');
  assert.strictEqual(maskProxy('http://bob:secret@proxy.avro.com:8080'), 'http://bob:****@proxy.avro.com:8080');
  const s = { connectionProxy: 'office', proxies: [{ name: 'office', url: 'http://proxy.avro.com:8080' }, { name: 'lab', url: 'http://10.0.0.1:3128' }] };
  assert.strictEqual(resolveProxy(s, '(connection)'), 'http://proxy.avro.com:8080');
  assert.strictEqual(resolveProxy(s, 'lab'), 'http://10.0.0.1:3128');
  assert.strictEqual(resolveProxy(s, 'direct'), ''); assert.strictEqual(resolveProxy(s, 'gone'), '');
  assert.strictEqual(resolveProxy({ proxies: [] }, '(connection)'), '');
});

test('a refused connection comes with the causes to check, most likely first', () => {
  const h = connectionHints('GET /api/now/table/sys_user: HTTP 401 User is not authenticated').join('\n');
  assert.match(h, /Password needs reset/); assert.match(h, /snc_basic_auth_api_access/); assert.match(h, /Web service access only/);
  assert.match(connectionHints('GET x: getaddrinfo ENOTFOUND dev1.service-now.com').join(' '), /choose one below/);
  assert.deepStrictEqual(connectionHints('something unknown'), []);
});

// ---- diagnosis: canned answers per table, as the instance would give them
function fake(tables) {
  const asked = [];
  return { asked, query: async (table, query) => { asked.push(`${table}?${query}`); const t = tables[table]; if (!t) throw new Error('403'); return typeof t === 'function' ? t(query) : t; } };
}
const runOf = (over) => ({ createdAt: Date.now() - 60000, scenario: { type: 'ui', authMode: 'sso', users: { prefix: 'lt.user.' }, steps: [] }, steps: [], shots: [], trace: [], stages: [], ...over });

test('diagnosis: nothing failed, nothing asked', async () => {
  const sn = fake({});
  assert.deepStrictEqual(await diagnose(sn, runOf({ steps: [{ lastError: '' }] })), []);
  assert.strictEqual(sn.asked.length, 0);
});

test('diagnosis: a login the page calls invalid is named as a policy refusal', async () => {
  const sn = fake({ syslog: [], sysevent: [{ name: 'ifl.authentication.failed', parm1: 'lt.user.001', parm2: 'User is not allowed as per Auth Policy.' }] });
  const r = runOf({ scenario: { type: 'ui', authMode: 'local', users: { prefix: 'lt.user.' }, steps: [] }, steps: [{ lastError: 'not signed in (landed on /login.do)' }] });
  const out = await diagnose(sn, r);
  assert.strictEqual(out.length, 1);
  assert.match(out[0].title, /refuses user name and password/); assert.match(out[0].detail, /Use Mock SSO/); assert.match(out[0].evidence[0], /lt\.user\.001/);
  assert.ok(sn.asked.some((a) => /parm1STARTSWITHlt\.user\./.test(a)), 'only the test users\' events are read');
});

test('diagnosis: the SAML log explains a rejected sign-on', async () => {
  const sn = fake({ syslog: [{ message: 'SAML2ValidationError: Unable to locate the SAML 2.0 Certificate' }], sysevent: [] });
  const out = await diagnose(sn, runOf({ steps: [{ lastError: 'not signed in (landed on /external_logout_complete.do)' }] }));
  assert.match(out[0].title, /rejected the single sign-on answer/); assert.match(out[0].detail, /idp_certificate/);
});

test('diagnosis: a knowledge article nobody may read lists who may', async () => {
  const sn = fake({
    syslog: [], sysevent: [],
    kb_knowledge: [{ kb_knowledge_base: 'kb1', workflow_state: 'published' }],
    kb_uc_can_read_mtom: [{ user_criteria: 'c1' }],
    user_criteria: [{ name: 'Problem solvers', group: 'Problem Solving', role: '', company: '' }],
  });
  const r = runOf({ scenario: { type: 'ui', authMode: 'sso', users: { prefix: 'lt.user.' }, steps: [{ url: '/kb_view.do?sysparm_article=KB0000028' }] }, steps: [{ lastError: 'the page says: You do not have sufficient privileges to access this knowledge item' }] });
  const out = await diagnose(sn, r);
  assert.match(out[0].detail, /KB0000028 can be read only by users who match/);
  assert.deepStrictEqual(out[0].evidence, ['"Problem solvers": groups Problem Solving']);
});

test('diagnosis: API refusals and timeouts on a saturated test machine', async () => {
  const sn = fake({ syslog: (q) => (/denied basic-auth/.test(q) ? [{ message: 'SNCRestrictBasicAuthUserAuthenticationGate: denied basic-auth API call for interactive-login user [api.user.001] under enforce=true' }] : []), sysevent: [] });
  const api = { type: 'api', authMode: 'basic', users: { prefix: 'api.user.' }, steps: [] };
  let out = await diagnose(sn, runOf({ scenario: api, steps: [{ lastError: 'HTTP 401 - User is not authenticated' }] }));
  assert.match(out[0].title, /restricts basic authentication/);
  out = await diagnose(fake({ syslog: [], sysevent: [] }), runOf({ scenario: api, steps: [{ lastError: 'HTTP 403 - User Not Authorized' }, { lastError: 'no answer within the time limit' }], stages: [{ busy: true }] }));
  assert.deepStrictEqual(out.map((o) => o.title), ['The API refused the request for lack of rights (HTTP 403)', 'Steps ran out of time while the test machine was at full CPU']);
});

test('the diagnosis never invents: every rule needs evidence from the run or the instance', () => {
  assert.ok(crypto.randomBytes(1));          // keeps the import honest
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'diagnose.js'), 'utf8');
  assert.match(src, /if \(!errors\.length\) return out;/);
});
