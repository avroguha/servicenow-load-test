'use strict';
// A load worker: one browser, many virtual users (one browser context each).
//
//   node src/worker.js --controller http://host:8787 --token <worker token> [--name w1] [--capacity 10]
//
// The worker asks the controller once a second what should be running and
// makes that true: start the users it was given, hold them while the run is
// paused, close everything when the run stops. It reports each step's timing
// (and screenshots) with the same call. The controller starts local workers by
// itself; run this by hand only to add another machine.
const os = require('node:os');
const { request } = require('./http');

const arg = (flag, env, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : (process.env[env] || dflt);
};
const CONTROLLER = String(arg('--controller', 'UILOAD_CONTROLLER', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const TOKEN = arg('--token', 'UILOAD_WORKER_TOKEN', '');
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

// ---- one page: waiting until it has gone quiet ---------------------------
// "Loaded" for a ServiceNow page is not the load event: the shell arrives, then
// the content is fetched. A step ends when no request has been in flight for
// `quietMs` (long-lived channels such as /amb are not counted).
function watch(page) {
  const w = { inflight: new Map(), lastChange: Date.now(), serverErrors: 0, requests: 0 };
  const skip = (r) => LONG_LIVED.test(r.url()) || ['websocket', 'eventsource'].includes(r.resourceType());
  page.on('request', (r) => { if (skip(r)) return; w.inflight.set(r, 0); w.requests += 1; w.lastChange = Date.now(); });
  const done = (r) => { if (w.inflight.delete(r)) w.lastChange = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('response', (r) => {
    if (r.status() >= 500) w.serverErrors += 1;
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
        this.signedIn = false;
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
    this.signedIn = false;
  }

  // Runs `fn`, waits for the page to settle, and reports one sample.
  async measured(index, name, fn, { shot }) {
    const cfg = this.run.cfg;
    const w = this.w;
    const t0 = Date.now();
    const s = { vu: this.spec.id, step: index, name, ok: true, t: t0, status: 0, error: '' };
    w.serverErrors = 0; w.requests = 0; w.lastChange = t0;
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
    if (u.origin !== cfg.origin) return `left the instance: ${u.origin}${u.pathname}`;
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
    const s = await this.measured(-1, cfg.authMode === 'sso' ? 'Sign in (SSO)' : 'Sign in (local)', async () => {
      if (cfg.authMode === 'sso') {
        const r = await page.goto(`${cfg.origin}/login_with_sso.do?glide_sso_id=${cfg.ssoId}`, { waitUntil: 'load', timeout: cfg.timeoutMs });
        return r ? r.status() : 0;
      }
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
        if (viaLink) url += `${url.includes('?') ? '&' : '?'}glide_sso_id=${cfg.ssoId}`;
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
        status = r ? r.status() : 0;
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
}
async function reconcile() {
  if (current && (desired.state === 'stopped' || desired.state === 'idle' || desired.runId !== current.runId)) await endRun();
  if (!desired.runId || !['running', 'paused'].includes(desired.state)) return;
  if (!current) {
    current = { runId: desired.runId, cfg: desired.config, vus: new Map(), errorShots: 0, browser: null };
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
    const r = await fetch(`${CONTROLLER}/w/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worker-Token': TOKEN },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (r.status === 401) { console.error('worker: the controller refused the token'); process.exit(2); }
    desired = await r.json();
    out.fatal = '';
    sync.failures = 0;
  } catch (err) {
    // Keep what could not be delivered; a worker that has lost its controller
    // for a minute stops loading the instance.
    out.samples.unshift(...body.samples); out.shots.unshift(...body.shots); out.finished.unshift(...body.finished);
    sync.failures = (sync.failures || 0) + 1;
    if (sync.failures === 60) { desired = { state: 'stopped' }; if (LOCAL) { await endRun(); process.exit(0); } }
  }
}

async function main() {
  if (!TOKEN) { console.error('worker: --token (or UILOAD_WORKER_TOKEN) is required'); process.exit(2); }
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
module.exports = { watch, quiet, LOGIN_PATH };
