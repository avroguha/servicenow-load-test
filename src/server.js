'use strict';
// The web app: accounts, tests, run control, live status, the workers' endpoint
// and the mock identity provider, on one port.
//
//   UILOAD_HOST (default 127.0.0.1), UILOAD_PORT (default 8787), UILOAD_DATA (default ./data)
//
// HTTPS: set UILOAD_CERTS to a folder (tls.crt, tls.key; a self-signed pair is made when it
// is empty). The app then serves HTTPS on UILOAD_HTTPS_PORT (8443) for people, redirects
// plain HTTP on UILOAD_REDIRECT_PORT (8081), and keeps UILOAD_PORT on loopback only, for its
// own workers, the health check and the mock sign-in pages. Without UILOAD_CERTS it serves
// plain HTTP, and only on loopback unless UILOAD_PLAIN_HTTP=1 says a TLS proxy stands in front.
const http = require('node:http');
const https = require('node:https');
const tlsFiles = require('./tls');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const { SN } = require('./sn');
const { maskProxy } = require('./http');
const { connectionHints } = require('./diagnose');
const idp = require('./idp');
const { Controller, normalize, validate, plan, cleanStored, janitor, records, limits, recordingOf, MAX_RUN_MS } = require('./run');

const HOST = process.env.UILOAD_HOST || '127.0.0.1';
const PORT = Number(process.env.UILOAD_PORT) || 8787;
const CERTS = process.env.UILOAD_CERTS || '';
const HTTPS_PORT = Number(process.env.UILOAD_HTTPS_PORT) || 8443;
const REDIRECT_PORT = Number(process.env.UILOAD_REDIRECT_PORT) || 8081;
const PUBLIC_HTTPS_PORT = Number(process.env.UILOAD_PUBLIC_HTTPS_PORT) || 443;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ---- accounts ----------------------------------------------------------------
// Local accounts kept in the data folder. One administrator, admin / admin, is
// seeded at first start; the page shows a red bar until that password is
// changed. Nothing forces the change. Administrators hold the ServiceNow
// credentials and the limits; testers create and run tests.
const sessions = new Map();          // session id -> { name, exp }
const wrong = new Map();             // user name -> { n, until }
const hash = (pw, salt) => crypto.pbkdf2Sync(pw, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex');
function accounts() {
  let a = store.read('auth.json', null);
  if (a && !a.users) a = { users: [{ name: 'admin', role: 'admin', salt: a.salt, hash: a.hash, isDefault: !!a.isDefault }] };   // the first version kept one account
  if (!a) { const salt = crypto.randomBytes(16).toString('hex'); a = { users: [{ name: 'admin', role: 'admin', salt, hash: hash('admin', salt), isDefault: true }] }; }
  return a;
}
function saveAccounts(a) { store.write('auth.json', a); }
function setPassword(name, pw, { isDefault = false } = {}) {
  const a = accounts();
  const u = a.users.find((x) => x.name === name);
  u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hash(pw, u.salt); u.isDefault = isDefault;
  saveAccounts(a);
  for (const [sid, s] of sessions) if (s.name === name) sessions.delete(sid);
}
function who(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)uiload_sid=([a-f0-9]+)/);
  const s = m && sessions.get(m[1]);
  if (!s || s.exp < Date.now()) return null;
  const u = accounts().users.find((x) => x.name === s.name);
  return u ? { name: u.name, role: u.role, isDefault: !!u.isDefault, sid: m[1] } : null;
}

// ---- helpers ------------------------------------------------------------------
function send(res, code, body, headers = {}) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(raw ? body : JSON.stringify(body));
}
function readBody(req, max = 40e6) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('request too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
const json = async (req) => { const t = await readBody(req); return t ? JSON.parse(t) : {}; };
const publicSettings = (s, admin) => ({
  instances: (s.instances || []).map((i) => ({ id: i.id, name: i.name, url: i.url, user: admin ? i.user : '', hasPassword: !!i.password, proxy: i.proxy || '' })),
  browser: s.browser, headless: s.headless,
  idpBaseUrl: s.idpBaseUrl, maxBrowsers: s.maxBrowsers, maxApiUsers: s.maxApiUsers, workerToken: admin ? s.workerToken : '', limits: limits(s),
  autoCleanMinutes: MAX_RUN_MS / 60000,
  // Testers choose a proxy by name; only administrators see where it points.
  proxies: (s.proxies || []).map((p) => ({ name: p.name, url: admin ? maskProxy(p.url) : '' })),
});

const ctl = new Controller({ port: PORT });

// Runs the app did not finish (it was closed mid-run) may have left records on
// the instance. They are marked here and removed by the janitor below.
for (const r of store.listRuns()) {
  if (!['done', 'failed'].includes(r.state)) {
    r.state = 'failed'; r.phase = 'Interrupted: the app was closed during this run.';
    r.endedAt = r.endedAt || Date.now(); r.cleanup = { complete: false, deleted: 0, failed: [], remaining: r.ledgerRows || [] };
    store.saveRun(r.id, r);
  }
}
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try { store.purgeOldScenarios(); } catch { /* next round */ }
  try { await janitor(ctl.busy() ? ctl.run.id : ''); } catch { /* no credentials yet, or the instance is away: next round */ }
  sweeping = false;
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/login' && m === 'POST') {
    const b = await json(req);
    const name = String(b.user || '').trim().toLowerCase();
    const w = wrong.get(name) || { n: 0, until: 0 };
    if (w.until > Date.now()) return send(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
    const u = accounts().users.find((x) => x.name === name);
    const ok = !!u && crypto.timingSafeEqual(Buffer.from(hash(String(b.password || ''), u.salt)), Buffer.from(u.hash));
    if (!ok) { w.n += 1; if (w.n >= 5) { w.until = Date.now() + 15 * 60e3; w.n = 0; } wrong.set(name, w); return send(res, 401, { error: 'Wrong user name or password.' }); }
    wrong.delete(name);
    if (!store.read('auth.json', null) || !store.read('auth.json', {}).users) saveAccounts(accounts());
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { name, exp: Date.now() + 12 * 3600e3 });
    return send(res, 200, { ok: true }, { 'Set-Cookie': `uiload_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${req.socket.encrypted ? '; Secure' : ''}` });
  }
  const me = who(req);
  if (p === '/api/me') return send(res, 200, me ? { signedIn: true, name: me.name, role: me.role, defaultPassword: me.isDefault } : { signedIn: false });
  if (!me) return send(res, 401, { error: 'Sign in first.' });
  const admin = me.role === 'admin';
  const adminOnly = () => { send(res, 403, { error: 'Only an administrator can do this.' }); };

  if (p === '/api/logout' && m === 'POST') { sessions.delete(me.sid); return send(res, 200, { ok: true }, { 'Set-Cookie': 'uiload_sid=; Path=/; Max-Age=0' }); }
  if (p === '/api/password' && m === 'POST') {
    const b = await json(req);
    if (String(b.password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters.' });
    setPassword(me.name, String(b.password));
    return send(res, 200, { ok: true });
  }

  // ---- people ----
  if (p === '/api/users' && m === 'GET') return admin ? send(res, 200, accounts().users.map((u) => ({ name: u.name, role: u.role, defaultPassword: !!u.isDefault }))) : adminOnly();
  if (p === '/api/users' && m === 'POST') {
    if (!admin) return adminOnly();
    const b = await json(req);
    const name = String(b.name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(name)) return send(res, 400, { error: 'User name: 2-31 letters, digits, dot, dash or underscore.' });
    if (String(b.password || '').length < 8) return send(res, 400, { error: 'Password: at least 8 characters.' });
    const a = accounts();
    if (a.users.some((u) => u.name === name)) return send(res, 409, { error: 'That user name is taken.' });
    const salt = crypto.randomBytes(16).toString('hex');
    a.users.push({ name, role: b.role === 'admin' ? 'admin' : 'tester', salt, hash: hash(String(b.password), salt), isDefault: false });
    saveAccounts(a);
    return send(res, 200, { ok: true });
  }
  const um = p.match(/^\/api\/users\/([a-z0-9._-]+)$/);
  if (um && m === 'DELETE') {
    if (!admin) return adminOnly();
    const a = accounts();
    const u = a.users.find((x) => x.name === um[1]);
    if (!u) return send(res, 404, { error: 'No such user.' });
    if (u.name === me.name) return send(res, 400, { error: 'You cannot remove yourself.' });
    if (u.role === 'admin' && a.users.filter((x) => x.role === 'admin').length === 1) return send(res, 400, { error: 'The last administrator stays.' });
    a.users = a.users.filter((x) => x !== u); saveAccounts(a);
    for (const [sid, s] of sessions) if (s.name === u.name) sessions.delete(sid);
    return send(res, 200, { ok: true });
  }

  // ---- ServiceNow connection and capacity ----
  if (p === '/api/settings' && m === 'GET') return send(res, 200, publicSettings(store.settings(), admin));
  if (p === '/api/settings' && m === 'PUT') {
    if (!admin) return adminOnly();
    if (ctl.busy()) return send(res, 409, { error: 'Settings cannot change during a run.' });
    const patch = await json(req);
    if (patch.instances !== undefined) {
      // An instance that still holds records of an unfinished cleanup cannot be removed: its login is needed to remove them.
      const kept = new Set((patch.instances || []).map((i) => i.id));
      const owed = records(ctl.run).find((r) => r.state === 'left' && r.instanceId && !kept.has(r.instanceId));
      if (owed) return send(res, 409, { error: `"${owed.instance}" still has records from the run "${owed.name}" on it. Clean them up first (ServiceNow > Records on the instance).` });
    }
    return send(res, 200, publicSettings(store.saveSettings(patch), true));
  }
  if (p === '/api/settings/test' && m === 'POST') {
    if (!admin) return adminOnly();
    try {
      const sn = SN.fromSettings(store.settings(), (await json(req)).instanceId);
      const self = await sn.query('sys_user', `user_name=${sn.userName}`, 'sys_id,name,user_name', 1);
      const props = await sn.query('sys_properties', 'nameINglide.buildtag,glide.war,glide.authenticate.multisso.enabled', 'name,value');
      const val = (n) => (props.find((x) => x.name === n) || {}).value || '';
      const roles = self.length ? await sn.query('sys_user_has_role', `user=${self[0].sys_id}^role.name=admin`, 'sys_id', 1) : [];
      return send(res, 200, { ok: true, user: self.length ? (self[0].name || self[0].user_name) : '', admin: roles.length > 0, build: val('glide.buildtag') || val('glide.war'), multiSso: val('glide.authenticate.multisso.enabled') === 'true' });
    } catch (err) { return send(res, 200, { ok: false, error: err.message, hints: connectionHints(err.message) }); }
  }

  // ---- tests ----
  if (p === '/api/scenarios' && m === 'GET') return send(res, 200, store.scenarios().map((s) => { const sc = normalize(s); const rec = recordingOf(sc); return { ...sc, recorded: rec ? { at: rec.at, requests: rec.requests, data: rec.data, visitSeconds: rec.visitSeconds } : null }; }));
  if (p === '/api/scenarios' && m === 'PUT') {
    const b = await json(req);
    const sc = normalize(b);
    const all = store.scenarios();
    const old = all.find((x) => x.id === b.id);
    sc.id = old ? old.id : crypto.randomBytes(6).toString('hex');
    sc.createdBy = old ? old.createdBy || me.name : me.name;
    sc.updatedAt = Date.now(); sc.updatedBy = me.name;
    store.saveScenarios([...all.filter((x) => x.id !== sc.id), sc]);
    const s = store.settings();
    const problems = validate(sc, limits(s));
    if (sc.instance && !s.instances.some((i) => i.id === sc.instance)) problems.push('The ServiceNow instance chosen for this test is no longer configured.');
    return send(res, 200, { scenario: sc, problems, plan: plan(sc) });
  }
  // Deleting a test puts it in the recycle bin; from there it can be put back, or removed for good.
  if (p === '/api/scenarios/bin' && m === 'GET') return send(res, 200, { days: store.BIN_DAYS, tests: store.binned().map((s) => ({ id: s.id, name: s.name, type: s.type, deletedAt: s.deletedAt, deletedBy: s.deletedBy || '', goesAt: s.deletedAt + store.BIN_DAYS * 86400000 })) });
  const sm = p.match(/^\/api\/scenarios\/([a-f0-9]+)$/);
  if (sm && m === 'DELETE') {
    if (ctl.busy() && ctl.run.scenario && ctl.run.scenario.id === sm[1]) return send(res, 409, { error: 'This test is running now. Stop the run first, then delete the test.' });
    if (!store.binScenario(sm[1], me.name)) return send(res, 404, { error: 'This test no longer exists.' });
    return send(res, 200, { ok: true, days: store.BIN_DAYS });
  }
  const bm = p.match(/^\/api\/scenarios\/([a-f0-9]+)\/(restore|forever)$/);
  if (bm && bm[2] === 'restore' && m === 'POST') { const sc = store.restoreScenario(bm[1]); return sc ? send(res, 200, { ok: true, name: sc.name }) : send(res, 404, { error: 'This test is not in the recycle bin.' }); }
  if (bm && bm[2] === 'forever' && m === 'DELETE') return store.purgeScenario(bm[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'This test is not in the recycle bin.' });

  // ---- runs ----
  if (p === '/api/status') return send(res, 200, ctl.status());
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let dirty = true;
    const mark = () => { dirty = true; };
    ctl.listeners.add(mark);
    const t = setInterval(() => { if (dirty) { dirty = false; res.write(`data: ${JSON.stringify(ctl.status())}\n\n`); } else res.write(': keep\n\n'); }, 1000);
    req.on('close', () => { clearInterval(t); ctl.listeners.delete(mark); });
    return undefined;
  }
  if (p === '/api/run' && m === 'POST') {
    const b = await json(req);
    const sc = store.scenarios().find((x) => x.id === b.scenarioId);
    if (!sc) return send(res, 404, { error: 'Save the test first.' });
    return send(res, 200, { id: await ctl.start(b.kind === 'build' ? 'build' : 'load', sc, me.name) });
  }
  const act = p.match(/^\/api\/run\/(pause|resume|stop)$/);
  if (act && m === 'POST') { if (act[1] === 'stop') ctl.stop(`Stopped by ${me.name}`); else ctl[act[1]](); return send(res, 200, { ok: true }); }

  if (p === '/api/runs' && m === 'GET') {
    return send(res, 200, store.listRuns().map((r) => ({ id: r.id, kind: r.kind, state: r.state, phase: r.phase, name: r.scenario && r.scenario.name, instance: r.instance ? r.instance.name : '', type: r.scenario && r.scenario.type, pattern: r.scenario && r.scenario.load && r.scenario.load.pattern, by: r.by || '', createdAt: r.createdAt, endedAt: r.endedAt, users: r.users, totals: r.totals, limit: r.limit, steps: (r.steps || []).map((s) => ({ name: s.name, p95: s.p95, n: s.n, errors: s.errors })), cleanup: r.cleanup && { complete: r.cleanup.complete, remaining: (r.cleanup.remaining || []).length }, ledger: r.ledger })));
  }
  if (p === '/api/records' && m === 'GET') return send(res, 200, { runs: records(ctl.run), autoCleanMinutes: MAX_RUN_MS / 60000 });
  if (p === '/api/records/clean' && m === 'POST') { await sweep(); return send(res, 200, { runs: records(ctl.run) }); }
  const rm = p.match(/^\/api\/runs\/([\w-]+)(?:\/(cleanup|shots\/[\w.]+))?$/);
  if (rm) {
    const [, id, sub] = rm;
    if (!sub && m === 'GET') { const r = store.readRun(id); if (!r) return send(res, 404, { error: 'No such run.' }); delete r.ledgerRows; return send(res, 200, r); }
    if (!sub && m === 'DELETE') {
      const r = store.readRun(id);
      if (ctl.run && ctl.run.id === id && ctl.busy()) return send(res, 409, { error: 'This run is active.' });
      if (r && r.cleanup && !r.cleanup.complete) return send(res, 409, { error: 'This run may still have records on the instance. Clean it up first (ServiceNow > Records on the instance).' });
      if (ctl.run && ctl.run.id === id) ctl.run = null;
      store.deleteRun(id); return send(res, 200, { ok: true });
    }
    if (sub === 'cleanup' && m === 'POST') {
      if (ctl.run && ctl.run.id === id && ctl.busy()) return send(res, 409, { error: 'This run is active. Stop it instead.' });
      const out = await cleanStored(id, `cleanup by ${me.name}`);
      if (ctl.run && ctl.run.id === id) { ctl.run.cleanup = out; ctl.notify(); }
      return send(res, 200, out);
    }
    if (sub && sub.startsWith('shots/') && m === 'GET') {
      const f = store.shotPath(id, sub.slice(6));
      if (!fs.existsSync(f)) return send(res, 404, 'not found');
      return send(res, 200, fs.readFileSync(f), { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    }
  }
  return send(res, 404, { error: 'Not found.' });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname === '/idp/sso') {
      const params = req.method === 'POST' ? new URLSearchParams(await readBody(req, 1e6)) : url.searchParams;
      return idp.handleSso(req, res, params);
    }
    if (url.pathname === '/idp/logout') return idp.handleLogout(req, res);
    if (url.pathname === '/w/sync' && req.method === 'POST') {
      const want = Buffer.from(store.settings().workerToken);
      const got = Buffer.from(String(req.headers['x-worker-token'] || ''));
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(res, 401, { error: 'bad worker token' });
      return send(res, 200, ctl.workerSync(await json(req)));
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const f = path.join(PUBLIC, name);
    if (!TYPES[path.extname(name)] || !fs.existsSync(f)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(f), { 'Content-Type': TYPES[path.extname(name)] });
  } catch (err) {
    return send(res, err instanceof SyntaxError ? 400 : 500, { error: err.message });
  }
}
const server = http.createServer(handle);

// Ctrl+C during a run: stop the load and clean the instance before leaving.
let leaving = false;
async function leave() {
  if (leaving) process.exit(1);
  leaving = true;
  if (ctl.busy()) {
    console.log('Stopping the run and cleaning up the instance before exit (press Ctrl+C again to skip)...');
    try { ctl.stop('The app is shutting down'); } catch { /* already stopping */ }
    const until = Date.now() + 180000;
    while (ctl.busy() && Date.now() < until) await new Promise((s) => setTimeout(s, 300));
  }
  process.exit(0);
}
process.on('SIGINT', leave); process.on('SIGTERM', leave);

if (require.main === module) {
  saveAccounts(accounts());
  setTimeout(sweep, 20000).unref();
  setInterval(sweep, 5 * 60000).unref();
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (CERTS) {
    const names = [process.env.UILOAD_PUBLIC_HOST, ...String(process.env.UILOAD_TLS_NAMES || '').split(',')].map((n) => String(n || '').trim()).filter(Boolean);
    tlsFiles.ensure(CERTS, names);
    const pair = tlsFiles.read(CERTS);
    const secure = https.createServer({ cert: pair.cert, key: pair.key }, handle);
    tlsFiles.watch(CERTS, secure, pair);
    secure.listen(HTTPS_PORT, loopback ? '0.0.0.0' : HOST, () => console.log(`ServiceNow load test: https on port ${HTTPS_PORT} (certificate: ${pair.subject}, valid to ${pair.validTo}); sign in admin / admin until changed`));
    // Plain HTTP only sends people to HTTPS.
    http.createServer((req, res) => {
      const host = String(req.headers.host || process.env.UILOAD_PUBLIC_HOST || 'localhost').replace(/:\d+$/, '');
      res.writeHead(301, { Location: `https://${host}${PUBLIC_HTTPS_PORT === 443 ? '' : `:${PUBLIC_HTTPS_PORT}`}${req.url}` });
      res.end();
    }).listen(REDIRECT_PORT, loopback ? '0.0.0.0' : HOST);
    // The app's own workers, the health check and the mock sign-in pages stay on this machine.
    server.listen(PORT, '127.0.0.1');
  } else {
    if (!loopback && process.env.UILOAD_PLAIN_HTTP !== '1') {
      console.error('Refusing to serve plain HTTP on a network address. Set UILOAD_CERTS to a folder for HTTPS, or UILOAD_PLAIN_HTTP=1 when a TLS-terminating proxy stands in front.');
      process.exit(1);
    }
    server.listen(PORT, HOST, () => console.log(`ServiceNow load test: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (sign in: admin / admin until changed)`));
  }
}
module.exports = { server, ctl };
