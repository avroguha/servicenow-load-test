'use strict';
// A load worker: one browser, many virtual users (one browser context each).
//
//   node src/worker.js --controller https://host --token-file <file> [--name w1] [--capacity 10] [--ca <file> | --insecure]
//
// The worker asks the controller once a second what should be running and
// makes that true: start the users it was given, hold them while the run is
// paused, close everything when the run stops. It reports each step's timing
// (and screenshots) with the same call. The controller starts local workers by
// itself; run this by hand only to add another machine.
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { request } = require('./http');

const arg = (flag, env, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : (process.env[env] || dflt);
};
const CONTROLLER = String(arg('--controller', 'UILOAD_CONTROLLER', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
// The token: given directly, or (better) in a file only this user can read.
const TOKEN_FILE = arg('--token-file', 'UILOAD_WORKER_TOKEN_FILE', '');
let TOKEN = arg('--token', 'UILOAD_WORKER_TOKEN', '');
const CA_FILE = arg('--ca', 'UILOAD_CONTROLLER_CA', '');
const INSECURE = process.argv.includes('--insecure') || process.env.UILOAD_CONTROLLER_INSECURE === '1';
const NAME = arg('--name', 'UILOAD_WORKER_NAME', `${os.hostname()}-${process.pid}`);
const CAPACITY = Number(arg('--capacity', 'UILOAD_WORKER_CAPACITY', 10)) || 10;
const LOCAL = process.env.UILOAD_WORKER_LOCAL === '1';

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const STOP = Symbol('stop');
const LONG_LIVED = /\/amb\/|\/amb_session|heartbeat|\/api\/now\/ui\/presence/i;
const BODY_GRACE_MS = 3000;
const REFUSAL = /You do not have sufficient privileges[^\n.]*|Security constraints prevent access[^\n.]*|Record not found|Page not found|Not Authorized|Access Denied|Knowledge record not found/i;
const LOGIN_PATH = /\/(login|logout|external_logout_complete|auth_redirect|login_with_sso|login_locate_sso|sso_login)\b/i;

const out = { samples: [], shots: [], traces: [], finished: [], log: [] };
let desired = { state: 'idle' };
let current = null;            // { runId, cfg, browser, vus: Map, errorShots }
let lastCpu = null;

function cpuPercent() {
  const now = os.cpus().reduce((a, c) => {
    const t = c.times;
    return { idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.irq + t.idle };
  }, { idle: 0, total: 0 });
  const prev = lastCpu; lastCpu = now;
  if (!prev || now.total === prev.total) return 0;
  return Math.round(100 * (1 - (now.idle - prev.idle) / (now.total - prev.total)));
}

// ---- talking to the controller ---------------------------------------------
// From another machine the controller is reached over HTTPS, and its
// certificate is often one this machine has no reason to trust (the app's own
// self-signed one, or a company authority Node does not know). Two answers:
// --ca <file> names the certificate (or its authority) to trust, and
// --insecure accepts any certificate - the worker token then travels to
// whoever answers, so that is for a lab only.
const talkAgent = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
let caPem;
function talk(method, pathAndQuery, headers, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(CONTROLLER + pathAndQuery);
    const tls = u.protocol === 'https:';
    if (tls && CA_FILE && caPem === undefined) caPem = fs.readFileSync(CA_FILE);
    const req = (tls ? https : http).request(u, {
      method, headers: { ...headers, ...(body != null ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, agent: talkAgent[u.protocol], timeout: timeoutMs,
      ...(tls ? { rejectUnauthorized: !INSECURE, ...(caPem ? { ca: caPem } : {}) } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('no answer from the controller within the time limit')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
// Why the controller cannot be reached, in words, with what to do about it.
function whyNot(err) {
  const m = `${err.code || ''} ${err.message || err}`;
  if (/self.signed|SELF_SIGNED|UNABLE_TO_VERIFY|unable to verify|unable to get (local )?issuer|CERT_/i.test(m)) return `this machine does not trust the controller's certificate (${err.code || err.message}). Give the certificate, or the authority that signed it, as ca.pem in the worker folder (Docker) or with --ca <file>; in a lab, WORKER_ACCEPT_ANY_CERTIFICATE=1 or --insecure (UILOAD_CONTROLLER_INSECURE=1) accepts any certificate.`;
  if (/ALTNAME|does not match/i.test(m)) return `the controller's certificate is for another name than ${new URL(CONTROLLER).hostname}. Use the name the certificate was made for, or --ca with a certificate that carries this name.`;
  if (/ECONNREFUSED/.test(m)) return `nothing answers at ${CONTROLLER} (connection refused). Check the address and the port: with HTTPS on, workers use the same address people open in the browser.`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `the name ${new URL(CONTROLLER).hostname} cannot be resolved from this machine.`;
  if (/ETIMEDOUT|time limit|EHOSTUNREACH|ENETUNREACH/.test(m)) return `${CONTROLLER} cannot be reached from this machine (no answer). A firewall between the two machines must allow this machine to open the controller's HTTPS port.`;
  return String(err.message || err);
}

// ---- the sign-in pages, on this machine ------------------------------------
// ServiceNow sends a test browser to the address in the run's identity
// provider record, and that address is on the browser's own machine
// (http://127.0.0.1:<port>). On the controller's machine the app itself answers
// there. On any other machine this relay does: it listens on that port, on
// loopback only, and passes the request to the controller. So the record on the
// instance is the same wherever the browsers run, and no browser has to trust
// the controller's certificate.
let relay = null;
function relayWanted(cfg) {
  if (cfg.type === 'api' || cfg.authMode !== 'sso') return 0;
  try {
    const u = new URL(cfg.idpBaseUrl);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol !== 'http:') return 0;   // the browsers reach the app directly
    const c = new URL(CONTROLLER);
    if (['127.0.0.1', 'localhost'].includes(c.hostname) && (c.port || '80') === (u.port || '80')) return 0;   // the controller is right here
    return Number(u.port || 80);
  } catch { return 0; }
}
function startRelay(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (!req.url.startsWith('/idp/')) { res.writeHead(404); res.end(); return; }
      const chunks = [];
      req.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
      req.on('end', async () => {
        try {
          const headers = {};
          for (const h of ['cookie', 'content-type']) if (req.headers[h]) headers[h] = req.headers[h];
          const r = await talk(req.method, req.url, headers, req.method === 'POST' ? Buffer.concat(chunks) : null, 30000);
          const back = {};
          for (const h of ['content-type', 'cache-control']) if (r.headers[h]) back[h] = r.headers[h];
          res.writeHead(r.status, back); res.end(r.body);
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`The worker could not pass the sign-in to the controller: ${whyNot(err)}`);
        }
      });
    });
    srv.once('error', async (err) => {
      if (err.code !== 'EADDRINUSE') { reject(err); return; }
      // Another worker on this machine may already be answering there: that is as good.
      const ours = await new Promise((s) => {
        const q = http.get({ host: '127.0.0.1', port, path: '/idp/logout', timeout: 5000 }, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => s(r.statusCode === 200 && /test identity provider/.test(t))); });
        q.on('error', () => s(false)); q.on('timeout', () => { q.destroy(); s(false); });
      });
      if (ours) { resolve(null); return; }
      reject(new Error(`Port ${port} on this worker machine is already in use, and the sign-in pages of a Mock SSO test must be answered there. Stop what uses it, or set another port under "Address of this app as the workers' browsers see it" (for example http://127.0.0.1:8790).`));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// ---- one page: waiting until it has gone quiet ---------------------------
// "Loaded" for a ServiceNow page is not the load event: the shell arrives, then
// the content is fetched. A step ends when no request has been in flight for
// `quietMs` (long-lived channels such as /amb are not counted).
function watch(page) {
  const w = { inflight: new Map(), lastChange: Date.now(), serverErrors: 0, requests: 0, path: [] };
  const skip = (r) => LONG_LIVED.test(r.url()) || ['websocket', 'eventsource'].includes(r.resourceType());
  page.on('request', (r) => { if (skip(r)) return; w.inflight.set(r, 0); w.requests += 1; w.lastChange = Date.now(); });
  const done = (r) => { if (w.inflight.delete(r)) w.lastChange = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('response', (r) => {
    if (r.status() >= 500) w.serverErrors += 1;
    // Every document the browser itself was sent to, in order: on a failed sign-in this is the story.
    try {
      const q = r.request();
      if (q.isNavigationRequest() && q.frame() === page.mainFrame() && w.path.length < 14) { const u = new URL(r.url()); w.path.push(`${r.status()} ${u.origin}${u.pathname}`); }
    } catch { /* a request with no frame */ }
    // A streamed answer never "finishes": once the server has answered, the
    // body gets a few seconds and is then no longer waited for.
    if (w.inflight.has(r.request())) { w.inflight.set(r.request(), Date.now()); w.lastChange = Date.now(); }
  });
  return w;
}
function pending(w) {
  const now = Date.now();
  for (const [r, answered] of w.inflight) if (answered && now - answered > BODY_GRACE_MS) { w.inflight.delete(r); }
  return w.inflight.size;
}
async function quiet(w, quietMs, deadline) {
  for (;;) {
    const open = pending(w);
    if (open === 0 && Date.now() - w.lastChange >= quietMs) return w.lastChange;
    if (Date.now() > deadline) {
      const what = [...w.inflight.keys()].slice(0, 3).map((r) => { try { return new URL(r.url()).pathname.slice(0, 60); } catch { return '?'; } });
      throw new Error(`still loading after the time limit (${open} request(s) open: ${what.join(', ')})`);
    }
    await sleep(50);
  }
}
async function inAnyFrame(page, selector, deadline) {
  for (;;) {
    for (const f of page.frames()) {
      try { const l = f.locator(selector).first(); if (await l.count()) return l; } catch { /* frame went away */ }
    }
    if (Date.now() > deadline) throw new Error(`"${selector}" was not found on the page`);
    await sleep(150);
  }
}

// ---- one virtual user ------------------------------------------------------
class VU {
  constructor(run, spec) { this.run = run; this.spec = spec; this.stopped = false; this.ctx = null; this.page = null; this.signedIn = false; this.at = 'starting'; this.since = Date.now(); this.last = null; }

  // What this user is doing right now, for the live view.
  doing(what) { if (this.at !== what) { this.at = what; this.since = Date.now(); } }

  async gate() {
    for (;;) {
      if (this.stopped || desired.state === 'stopped' || desired.runId !== this.run.runId) throw STOP;
      if (desired.state !== 'paused') return;
      await sleep(200);
    }
  }

  async fresh() {
    const cfg = this.run.cfg;
    // A returning person: the session is gone, the browser's cache is not. Only
    // the first arrival of each user downloads every script and style sheet.
    if (this.ctx && this.page && cfg.sessionMode === 'relogin') {
      try {
        await this.page.goto('about:blank');
        await this.ctx.clearCookies();
        if (cfg.authMode === 'sso') await this.ctx.addCookies([{ name: 'uiload_idp', value: this.spec.ticket, url: cfg.idpBaseUrl, httpOnly: true }]);
        this.signedIn = false; this.cold = false;
        return;
      } catch { /* fall through to a new context */ }
    }
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.doing('opening a browser window');
    this.ctx = await within(this.run.browser.newContext({ viewport: cfg.viewport, ignoreHTTPSErrors: true }), 30000, 'opening a browser window');
    this.ctx.setDefaultTimeout(cfg.timeoutMs);
    if (cfg.authMode === 'sso') await this.ctx.addCookies([{ name: 'uiload_idp', value: this.spec.ticket, url: cfg.idpBaseUrl, httpOnly: true }]);
    this.page = await within(this.ctx.newPage(), 30000, 'opening a browser tab');
    this.w = watch(this.page);
    this.signedIn = false; this.cold = true;
  }

  // Runs `fn`, waits for the page to settle, and reports one sample.
  async measured(index, name, fn, { shot }) {
    const cfg = this.run.cfg;
    const w = this.w;
    const t0 = Date.now();
    const s = { vu: this.spec.id, step: index, name, ok: true, t: t0, status: 0, error: '' };
    w.serverErrors = 0; w.requests = 0; w.lastChange = t0; w.path = [];
    this.at = name; this.since = t0;
    try {
      const status = await fn(t0 + cfg.timeoutMs);
      const end = await quiet(w, cfg.quietMs, t0 + cfg.timeoutMs);
      s.ms = Math.max(1, end - t0);
      s.status = status || 0;
      if (s.status >= 400) { s.ok = false; s.error = `HTTP ${s.status}`; }
      const where = await this.where();
      if (where) { s.ok = false; s.error = where; this.signedIn = false; }
      else { const refused = await this.refusal(); if (refused) { s.ok = false; s.error = refused; } }
    } catch (err) {
      if (err === STOP) throw err;
      s.ok = false; s.ms = Date.now() - t0;
      s.error = String(err.message || err).split('\n')[0].slice(0, 300);
      if (!/^the page says/.test(s.error)) { const refused = await this.refusal().catch(() => ''); if (refused) s.error = refused; }
    }
    s.serverErrors = w.serverErrors; s.requests = w.requests;
    this.last = { ok: s.ok, ms: s.ms };
    try { s.url = this.page.url(); } catch { s.url = ''; }
    if (!s.ok) {
      s.path = w.path.slice();
      try { s.cookies = (await within(this.ctx.cookies(cfg.origin), 4000, 'reading the cookies')).map((c) => c.name).slice(0, 14); } catch { /* the window is gone */ }
    }
    out.samples.push(s);
    const wantShot = shot === 'all' || (!s.ok && this.run.errorShots < cfg.maxErrorShots);
    if (wantShot) {
      if (!s.ok) this.run.errorShots += 1;
      try {
        const buf = await this.page.screenshot({ type: 'jpeg', quality: 60, timeout: 15000 });
        out.shots.push({ vu: this.spec.id, user: this.spec.user, step: index, name, ok: s.ok, ms: s.ms, url: s.url, error: s.error, t: Date.now(), jpeg: buf.toString('base64') });
      } catch { /* a closed page has no picture */ }
    }
    return s;
  }

  // '' when the page belongs to a signed-in user; otherwise why not.
  async where() {
    const cfg = this.run.cfg;
    let u;
    try { u = new URL(this.page.url()); } catch { return ''; }
    if (u.origin !== cfg.origin) return cfg.authMode === 'sso' && this.signedIn
      ? `the session was lost: ServiceNow sent the browser to its own sign-on page (${u.origin}). The user signs in again at the test identity provider.`
      : `left the instance: ${u.origin}${u.pathname}`;
    if (LOGIN_PATH.test(u.pathname)) return `not signed in (landed on ${u.pathname})`;
    try {
      if (await within(this.page.locator('input[name="user_password"]').count(), 5000, 'reading the page')) return 'not signed in (the login page was shown)';
    } catch { /* navigating */ }
    return '';
  }

  // A page can load perfectly and still be a refusal. '' when it is not one.
  async refusal() {
    for (const f of this.page.frames()) {
      let text = '';
      try { text = await within(f.evaluate(() => (document.body ? document.body.innerText.slice(0, 4000) : '')), 4000, 'reading the page'); } catch { continue; }
      const m = text.match(REFUSAL);
      if (m) return `the page says: ${m[0]}`;
    }
    return '';
  }

  // Waits for the expected content, but stops at once when the page turns out
  // to be a refusal or the login page: that content will never come.
  async appear(selector, deadline) {
    const started = Date.now();
    let checked = 0;
    for (;;) {
      for (const f of this.page.frames()) {
        try { const l = f.locator(selector).first(); if (await l.count()) return l; } catch { /* frame went away */ }
      }
      if (Date.now() - started > 2500 && Date.now() - checked > 1500) {
        checked = Date.now();
        const refused = await this.refusal();
        if (refused) throw new Error(refused);
      }
      if (Date.now() > deadline) throw new Error(`"${selector}" was not found on the page`);
      await sleep(150);
    }
  }

  async signIn(shot) {
    const cfg = this.run.cfg;
    const page = this.page;
    const s = await this.measured(-1, cfg.authMode === 'sso' ? 'Sign in (SSO)' : 'Sign in (local)', async (deadline) => {
      if (cfg.authMode === 'sso') return this.arriveBySso(null, deadline);
      await page.goto(`${cfg.origin}/login.do`, { waitUntil: 'load', timeout: cfg.timeoutMs });
      await page.fill('#user_name', this.spec.user);
      await page.fill('#user_password', this.spec.password);
      await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: cfg.timeoutMs }), page.click('#sysverb_login')]);
      return 0;
    }, { shot });
    this.signedIn = s.ok;
    return s.ok;
  }

  async step(st, index, shot) {
    const cfg = this.run.cfg;
    const page = this.page;
    const name = st.name || `${st.type} ${st.url || st.selector || ''}`.trim();
    if (st.type === 'wait') { await this.pause(Number(st.ms) || 1000); return; }
    // Arriving from a link with no session: ServiceNow sends the browser to the
    // identity provider named in the link and brings it back to the same page.
    const viaLink = !this.signedIn && st.type === 'open' && cfg.entry === 'link';
    const s = await this.measured(index, name, async (deadline) => {
      let status = 0;
      if (st.type === 'open') {
        let url = /^https?:\/\//i.test(st.url) ? st.url : cfg.origin + (st.url.startsWith('/') ? '' : '/') + st.url;
        if (viaLink && cfg.authMode === 'sso') status = await this.arriveBySso(url, deadline);
        else {
          const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
          status = r ? r.status() : 0;
        }
      } else if (st.type === 'click') {
        await (await inAnyFrame(page, st.selector, deadline)).click({ timeout: cfg.timeoutMs });
        await sleep(100);
      } else if (st.type === 'fill') {
        const l = await inAnyFrame(page, st.selector, deadline);
        await l.fill(String(st.value == null ? '' : st.value), { timeout: cfg.timeoutMs });
        if (st.enter) await l.press('Enter');
        await sleep(100);
      } else throw new Error(`unknown step type "${st.type}"`);
      if (st.waitSelector) await this.appear(st.waitSelector, deadline);
      return status;
    }, { shot });
    if (viaLink) this.signedIn = s.ok;
  }

  // Arriving through a link with no session, as a person does from an e-mail.
  // ServiceNow sends such a browser to an identity provider. On an instance that
  // already has single sign-on, that is the company's own sign-on page, whatever
  // the link says - and a test user does not exist there. So the moment the
  // browser is sent anywhere outside the instance, it is taken to the test
  // identity provider instead (login_with_sso.do with the run's provider). The
  // company's sign-on page is never opened, and only test browsers are affected:
  // nothing is changed on the instance.
  async arriveBySso(target, deadline) {
    const cfg = this.run.cfg;
    const page = this.page;
    const sso = `${cfg.origin}/login_with_sso.do?glide_sso_id=${cfg.ssoId}`;
    let idpOrigin = '';
    try { idpOrigin = new URL(cfg.idpBaseUrl).origin; } catch { /* none */ }
    const foreign = (u) => { try { const o = new URL(String(u)).origin; return /^https?:/.test(o) && o !== cfg.origin && o !== idpOrigin; } catch { return false; } };
    let diverted = 0;
    const match = (u) => foreign(u.href);
    const divert = async (route) => {
      const q = route.request();
      let top = false;
      try { top = q.isNavigationRequest() && q.frame() === page.mainFrame(); } catch { /* no frame */ }
      if (!top) return route.continue();
      diverted += 1;
      if (!this.run.divertedFrom) {
        this.run.divertedFrom = new URL(q.url()).origin;
        out.log.push(`This instance sends arriving browsers to its own sign-on page (${this.run.divertedFrom}). Test browsers are taken to the test identity provider instead; that page is never opened.`);
      }
      if (diverted > 4) {
        // Four times asked for the test identity provider, four times sent away. The company's page is not opened: the request ends here.
        blockedAt = new URL(q.url()).origin;
        return route.abort('blockedbyclient');
      }
      if (diverted > 1) {
        // ServiceNow was asked for the run's provider and still chose its own. One application node may not know
        // the new record yet, and the browser is tied to that node by a cookie: wait, drop the instance's cookies
        // so the next request can land elsewhere, and ask again.
        this.run.retried = (this.run.retried || 0) + 1;
        if (this.run.retried === 1) out.log.push(`ServiceNow sent a test browser to ${new URL(q.url()).origin} although it was asked for the test identity provider. Trying again on a new connection (up to 3 times, with a pause).`);
        await sleep([0, 1000, 3000, 6000][diverted - 1]);
        await this.ctx.clearCookies({ domain: new URL(cfg.origin).hostname }).catch(() => {});
      }
      return route.fulfill({ status: 302, headers: { location: sso }, body: '' });
    };
    let blockedAt = '';
    const refusedMsg = () => `ServiceNow sent the browser to its own sign-on page (${blockedAt}) every time, also when asked 4 times for the test identity provider. That page was not opened. Open the identity provider record of this run on the instance while it is running and check it is active.`;
    // Every sign-in is watched, a returning browser's too: ServiceNow has been seen to honour the run's provider
    // on a browser's first visit and choose its own on the next. Watching navigations switches the browser
    // cache off while it lasts, so it ends the moment the browser is back on the instance from the test
    // provider - the page's own files then come from the cache as they would for a person.
    const guard = true;
    await page.route(match, divert);
    let watching = true;
    const unwatch = async () => { if (!watching) return; watching = false; await page.unroute(match, divert).catch(() => {}); };
    let visited = false;                 // has this browser been to the test identity provider?
    const seen = (f) => {
      try {
        if (f !== page.mainFrame()) return;
        const o = new URL(f.url()).origin;
        if (o === idpOrigin) visited = true;
        else if (visited && o === cfg.origin) unwatch();
      } catch { /* no url */ }
    };
    page.on('framenavigated', seen);
    try {
      const first = target ? `${target}${target.includes('?') ? '&' : '?'}glide_sso_id=${cfg.ssoId}` : sso;
      let r;
      try { r = await page.goto(first, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs }); } catch (err) { if (blockedAt) throw new Error(refusedMsg()); throw err; }
      if (!guard && foreign(page.url())) {
        // First seen on a returning browser: sign in at the test provider, then open the link.
        this.run.divertedFrom = new URL(page.url()).origin;
        out.log.push(`This instance sends arriving browsers to its own sign-on page (${this.run.divertedFrom}). Test browsers are taken to the test identity provider instead.`);
        await page.goto(sso, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
        diverted = 1;
      }
      const want = new URL(target || cfg.origin);
      const there = () => { try { const u = new URL(page.url()); return u.origin === cfg.origin && u.pathname === want.pathname && [...want.searchParams].every(([k, v]) => u.searchParams.get(k) === v); } catch { return false; } };
      // On the instance, and not on one of the pages a sign-in only passes through.
      const home = () => { try { const u = new URL(page.url()); return u.origin === cfg.origin && !/\/(navpage|login_with_sso|auth_redirect|login_redirect)\.do$/i.test(u.pathname); } catch { return false; } };
      let still = 0; let last = '';
      if (!diverted && target) {
        // Some links start no sign-in at all: a portal page open to guests, or
        // the login page. If the browser rests on the instance without having
        // been to the test identity provider, take it there.
        while (Date.now() < deadline && !visited) {
          const now = page.url();
          still = now === last && home() ? still + 1 : 0; last = now;
          // Decided quickly (0.3 s): waiting longer lets the page start a sign-in of its own that then races this one,
          // and ServiceNow rejects the answer to whichever request it did not keep ("No valid SubjectConfirmation").
          if (still >= 2) break;
          await sleep(150);
        }
        if (!visited && home()) {
          if (!this.run.noSsoNote) { this.run.noSsoNote = true; out.log.push(`ServiceNow did not start a sign-in for this link (the browser stayed on ${new URL(page.url()).pathname}). Test browsers sign in at the test identity provider and then open the link.`); }
          await page.goto(sso, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
          diverted = 1;
        }
        still = 0; last = '';
      }
      if (blockedAt) throw new Error(refusedMsg());
      if (diverted && target) {
        // The sign-in ends back on the instance. If ServiceNow did not keep the link, open it now.
        while (Date.now() < deadline && !there()) {
          const now = page.url();
          still = now === last && home() ? still + 1 : 0; last = now;
          if (still >= 8) break;                       // on the instance, 1.2 s on the same page that is not the link
          await sleep(150);
        }
        if (!there() && home()) r = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
      }
      if (blockedAt) throw new Error(refusedMsg());
      return r ? r.status() : 0;
    } finally {
      page.off('framenavigated', seen);
      await unwatch();
    }
  }

  async pause(ms) {
    this.doing('waiting');
    const end = Date.now() + ms;
    while (Date.now() < end) { await this.gate(); await sleep(Math.min(200, end - Date.now())); }
  }

  // A parallel test releases every user at the same instant; otherwise users
  // do not all arrive in the same moment.
  async arrive() {
    const cfg = this.run.cfg;
    if (cfg.startAt) { this.doing('ready, waiting for the start'); while (Date.now() < cfg.startAt) { await this.gate(); await sleep(25); } return; }
    if (cfg.iterations !== 1) await this.pause(Math.random() * Math.min(3000, cfg.thinkMs || 0));
  }

  async loop() {
    const cfg = this.run.cfg;
    const shot = cfg.screenshots;
    let iterations = 0;
    try {
      await this.arrive();
      for (;;) {
        await this.gate();
        if (!this.signedIn || cfg.sessionMode === 'relogin') {
          await this.fresh();
          const byLink = cfg.entry === 'link' && cfg.steps[0] && cfg.steps[0].type === 'open';
          if (!byLink && !(await this.signIn(shot))) {
            if (cfg.iterations) { iterations += 1; if (iterations >= cfg.iterations) break; }
            await this.pause(Math.max(5000, cfg.thinkMs || 0));
            continue;
          }
        }
        for (let i = 0; i < cfg.steps.length; i += 1) {
          await this.gate();
          await this.step(cfg.steps[i], i, shot);
          if (!this.signedIn) { if (cfg.entry === 'link') await this.pause(Math.max(3000, cfg.thinkMs || 0)); break; }
          if (cfg.thinkMs) await this.pause(cfg.thinkMs * (0.75 + Math.random() * 0.5));
        }
        iterations += 1;
        if (cfg.iterations && iterations >= cfg.iterations) break;
      }
    } catch (err) {
      if (err !== STOP) out.log.push(`${this.spec.user}: ${String(err.message || err).split('\n')[0]}`);
    }
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.done = true; this.at = 'finished';
    if (!this.stopped) out.finished.push(this.spec.id);
  }
}

// ---- one API user: plain HTTP requests, no browser ---------------------------
class ApiVU extends VU {
  async call(index, name, method, url, headers, body, keepText) {
    const cfg = this.run.cfg;
    const t0 = Date.now();
    const s = { vu: this.spec.id, step: index, name, ok: true, t: t0, status: 0, error: '', url, requests: 1, serverErrors: 0 };
    this.at = name; this.since = t0;
    let text = '';
    try {
      const r = await request({ method, url, headers, body, timeoutMs: cfg.timeoutMs, proxy: cfg.proxy });
      text = r.text;
      s.status = r.status; s.ms = Math.max(1, Date.now() - t0); s.bytes = text.length;
      if (r.status >= 300) {
        s.ok = false;
        let why = '';
        try { const j = JSON.parse(text); why = (j.error && (j.error.message || j.error)) || j.error_description || ''; } catch { /* not JSON */ }
        s.error = `HTTP ${r.status}${why ? ` - ${String(why).slice(0, 160)}` : ''}`;
      }
      if (r.status >= 500) s.serverErrors = 1;
    } catch (err) {
      s.ok = false; s.ms = Date.now() - t0;
      s.error = err.name === 'TimeoutError' ? 'no answer within the time limit' : String((err.cause && err.cause.message) || err.message).slice(0, 200);
    }
    this.last = { ok: s.ok, ms: s.ms };
    out.samples.push(s);
    const want = cfg.screenshots === 'all' || (!s.ok && this.run.errorShots < cfg.maxErrorShots);
    if (want) {
      if (!s.ok) this.run.errorShots += 1;
      // The token answer holds a secret, so its text is never kept.
      out.traces.push({ vu: this.spec.id, user: this.spec.user, step: index, name, ok: s.ok, ms: s.ms, status: s.status, url, error: s.error, t: Date.now(), bytes: s.bytes || 0, snippet: keepText ? text.slice(0, 500) : '(not shown)' });
    }
    return { s, text };
  }

  async token() {
    const cfg = this.run.cfg;
    const form = new URLSearchParams({ grant_type: 'password', client_id: cfg.oauth.clientId, client_secret: cfg.oauth.clientSecret, username: this.spec.user, password: this.spec.password });
    const { s, text } = await this.call(-1, 'Get OAuth token', 'POST', `${cfg.origin}/oauth_token.do`, { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, form.toString(), false);
    if (!s.ok) return false;
    try { this.bearer = JSON.parse(text).access_token || ''; } catch { this.bearer = ''; }
    return !!this.bearer;
  }

  async loop() {
    const cfg = this.run.cfg;
    let iterations = 0;
    const basic = `Basic ${Buffer.from(`${this.spec.user}:${this.spec.password}`).toString('base64')}`;
    try {
      await this.arrive();
      for (;;) {
        await this.gate();
        if (cfg.authMode === 'oauth' && !this.bearer && !(await this.token())) {
          iterations += 1;
          if (cfg.iterations && iterations >= cfg.iterations) break;
          await this.pause(Math.max(5000, cfg.thinkMs || 0));
          continue;
        }
        for (let i = 0; i < cfg.steps.length; i += 1) {
          await this.gate();
          const st = cfg.steps[i];
          if (st.type === 'wait') { await this.pause(Number(st.ms) || 1000); continue; }
          const url = /^https?:\/\//i.test(st.url) ? st.url : cfg.origin + (st.url.startsWith('/') ? '' : '/') + st.url;
          const headers = { Authorization: cfg.authMode === 'oauth' ? `Bearer ${this.bearer}` : basic, Accept: 'application/json' };
          if (st.body) headers['Content-Type'] = 'application/json';
          const { s } = await this.call(i, st.name || `${st.method || 'GET'} ${st.url}`, st.method || 'GET', url, headers, st.body || undefined, true);
          if (s.status === 401 && cfg.authMode === 'oauth') { this.bearer = ''; break; }
          if (cfg.thinkMs) await this.pause(cfg.thinkMs * (0.75 + Math.random() * 0.5));
        }
        iterations += 1;
        if (cfg.iterations && iterations >= cfg.iterations) break;
      }
    } catch (err) {
      if (err !== STOP) out.log.push(`${this.spec.user}: ${String(err.message || err).split('\n')[0]}`);
    }
    this.done = true; this.at = 'finished';
    if (!this.stopped) out.finished.push(this.spec.id);
  }
}

// ---- making the desired state true ----------------------------------------
async function launch(cfg) {
  const { chromium } = require('playwright-core');
  const opts = { headless: cfg.headless !== false, timeout: 45000, args: ['--disable-dev-shm-usage', '--no-default-browser-check'] };
  if (cfg.proxy) {
    // The mock sign-in pages are served by this app itself: never through the proxy.
    const p = new URL(cfg.proxy);
    let idpHost = '';
    try { idpHost = new URL(cfg.idpBaseUrl).hostname; } catch { /* none */ }
    opts.proxy = { server: `${p.protocol}//${p.host}`, bypass: ['127.0.0.1', 'localhost', idpHost].filter(Boolean).join(',') };
    if (p.username) { opts.proxy.username = decodeURIComponent(p.username); opts.proxy.password = decodeURIComponent(p.password); }
  }
  // Which browser: the one this image ships (it wins - the app's setting may
  // name a browser this machine does not have), then the one chosen in the app,
  // then every other kind. The setting being wrong must not stop a run when a
  // usable browser is right there.
  const kinds = { chromium: ["Playwright's own Chromium", {}], chrome: ['Google Chrome', { channel: 'chrome' }], msedge: ['Microsoft Edge', { channel: 'msedge' }] };
  const tries = [];
  if (process.env.UILOAD_BROWSER_PATH) tries.push([`the browser at ${process.env.UILOAD_BROWSER_PATH}`, { executablePath: process.env.UILOAD_BROWSER_PATH }]);
  for (const k of [cfg.browser || 'chrome', 'chromium', 'chrome', 'msedge']) if (kinds[k] && !tries.some((t) => t[0] === kinds[k][0])) tries.push(kinds[k]);
  const failed = [];
  for (const [name, how] of tries) {
    try {
      const b = await chromium.launch({ ...opts, ...how });
      if (failed.length) out.log.push(`Using ${name}. ${failed[0]}`);
      return b;
    } catch (err) { failed.push(`${name} did not start: ${String(err.message).split('\n')[0].slice(0, 200)}`); }
  }
  throw new Error(failed.join(' | '));
}
// A promise that must not be able to hang a user for ever.
function within(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} did not finish in ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
}
async function endRun() {
  const run = current; current = null;
  if (!run) return;
  for (const v of run.vus.values()) v.stopped = true;
  await Promise.race([Promise.all([...run.vus.values()].map((v) => v.task)), sleep(8000)]);
  if (run.browser) await run.browser.close().catch(() => {});
  if (relay) { const r = relay; relay = null; await new Promise((s) => { r.close(() => s()); if (r.closeAllConnections) r.closeAllConnections(); }); }
}
async function reconcile() {
  if (current && (desired.state === 'stopped' || desired.state === 'idle' || desired.runId !== current.runId)) await endRun();
  if (!desired.runId || !['running', 'paused'].includes(desired.state)) return;
  if (!current) {
    current = { runId: desired.runId, cfg: desired.config, vus: new Map(), errorShots: 0, browser: null };
    const port = relayWanted(current.cfg);
    if (port && !relay) try { relay = await startRelay(port); } catch (err) {   // null: another worker here already answers
      out.fatal = String(err.message || err);
      current = null; await sleep(5000); return;
    }
    if (current.cfg.type !== 'api') try { current.browser = await launch(current.cfg); } catch (err) {
      // Nothing can run without a browser: tell the controller, which ends the run with this reason.
      out.fatal = `No browser could be started on this worker. ${err.message}`;
      current = null; await sleep(5000); return;
    }
  }
  for (const spec of desired.vus || []) {
    if (current.vus.has(spec.id)) continue;
    const v = current.cfg.type === 'api' ? new ApiVU(current, spec) : new VU(current, spec);
    current.vus.set(spec.id, v);
    v.task = v.loop();
  }
}

async function sync() {
  const body = {
    name: NAME, capacity: CAPACITY, local: LOCAL, api: process.env.UILOAD_WORKER_API === '1', host: os.hostname(),
    // The run this worker is on, or has been told to be on: a worker that could not even start still has something to say about it.
    runId: (current && current.runId) || desired.runId || '', fatal: out.fatal || '',
    active: current ? [...current.vus.values()].filter((v) => !v.done).length : 0,
    sys: { cpu: cpuPercent(), freeMb: Math.round(os.freemem() / 1048576), totalMb: Math.round(os.totalmem() / 1048576) },
    samples: out.samples.splice(0), shots: out.shots.splice(0, 4), traces: out.traces.splice(0, 30), finished: out.finished.splice(0), log: out.log.splice(0),
    activity: current ? [...current.vus.values()].slice(0, 120).map((v) => ({ id: v.spec.id, user: v.spec.user, at: v.at, since: v.since, last: v.last, done: !!v.done })) : [],
  };
  try {
    const r = await talk('POST', '/w/sync', { 'Content-Type': 'application/json', 'X-Worker-Token': TOKEN }, JSON.stringify(body));
    if (r.status === 401) { console.error('worker: the controller refused the token. Copy it again from Administration > Capacity and workers.'); process.exit(2); }
    if (r.status !== 200) throw new Error(`the controller answered HTTP ${r.status} - is ${CONTROLLER} the address of the load test app?`);
    desired = JSON.parse(r.body.toString());
    if (!sync.connected) { sync.connected = true; console.log(`worker ${NAME}: connected to ${CONTROLLER}`); }
    out.fatal = '';
    sync.failures = 0;
  } catch (err) {
    // Keep what could not be delivered; a worker that has lost its controller
    // for a minute stops loading the instance.
    out.samples.unshift(...body.samples); out.shots.unshift(...body.shots); out.finished.unshift(...body.finished);
    sync.failures = (sync.failures || 0) + 1;
    // Said at once, and again every half minute: a worker that cannot reach its controller must not sit there mute.
    if (sync.failures === 1 || sync.failures % 30 === 0) console.error(`worker ${NAME}: cannot reach the controller - ${whyNot(err)}`);
    sync.connected = false;
    if (sync.failures === 60) { desired = { state: 'stopped' }; if (LOCAL) { await endRun(); process.exit(0); } }
  }
}

async function main() {
  if (!TOKEN && TOKEN_FILE) try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (err) { console.error(`worker: the token file ${TOKEN_FILE} cannot be read (${err.code || err.message})`); process.exit(2); }
  if (!TOKEN) { console.error('worker: the worker token is required: --token-file <file> (UILOAD_WORKER_TOKEN_FILE) or --token (UILOAD_WORKER_TOKEN). It is shown under Administration > Capacity and workers.'); process.exit(2); }
  if (CA_FILE && !fs.existsSync(CA_FILE)) { console.error(`worker: the certificate file ${CA_FILE} does not exist`); process.exit(2); }
  if (INSECURE && CONTROLLER.startsWith('https:')) console.error('worker: --insecure: the controller\'s certificate is NOT checked. For a lab only.');
  console.log(`worker ${NAME}: controller ${CONTROLLER}, up to ${CAPACITY} users`);
  const bye = async () => { await endRun(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  for (;;) {
    await sync();
    try { await reconcile(); } catch (err) { out.log.push(`worker: ${err.message}`); }
    if (desired.state === 'exit') { await endRun(); process.exit(0); }
    await sleep(1000);
  }
}

if (require.main === module) main();
module.exports = { watch, quiet, LOGIN_PATH, whyNot, relayWanted };
