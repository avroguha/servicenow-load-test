'use strict';
// The run controller: one run at a time, from checks to cleanup.
//
//   checking -> provisioning -> starting -> running <-> paused -> stopping -> done
//
// A validation run ("Test" on the page) is the same thing with one user, one
// pass and a screenshot (UI) or the answer (API) for every step. Stop - asked
// for, reached by the end of the plan, forced by a failure or by the two-hour
// limit - always ends in cleanup of what the run created on the instance.
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { SN } = require('./sn');
const prov = require('./provision');
const idp = require('./idp');
const store = require('./store');
const { resolveProxy } = require('./http');
const { diagnose } = require('./diagnose');

const BUCKET_MS = 5000;
const MAX_RUN_MS = 2 * 3600 * 1000;       // nothing a run created stays on the instance longer than this
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
function summary(ms) {
  if (!ms.length) return { n: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length), p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1] };
}

// How many browsers this machine can drive honestly: about 2.5 per core
// (measured), and about 400 MB each.
function hostInfo() {
  const cores = os.cpus().length;
  const memGb = Math.round((os.totalmem() / 1073741824) * 10) / 10;
  const suggestedBrowsers = Math.max(1, Math.min(Math.floor(cores * 2.5), Math.floor((memGb - 1) / 0.4)));
  return { cores, memGb, suggestedBrowsers, host: os.hostname() };
}
function limits(settings = store.settings()) {
  const h = hostInfo();
  return { ...h, maxBrowsers: Number(settings.maxBrowsers) > 0 ? Math.floor(Number(settings.maxBrowsers)) : h.suggestedBrowsers, maxApiUsers: Number(settings.maxApiUsers) > 0 ? Math.floor(Number(settings.maxApiUsers)) : 2000 };
}

function normalize(sc) {
  const n = (v, d, min = 0) => (v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  const load = sc.load || {};
  const limit = sc.limit || {};
  const type = sc.type === 'api' ? 'api' : 'ui';
  const steps = (sc.steps || []).filter((s) => s && s.type).map((s) => ({
    type: s.type, name: String(s.name || '').trim(), url: String(s.url || '').trim(), selector: String(s.selector || '').trim(),
    value: s.value == null ? '' : String(s.value), enter: !!s.enter, waitSelector: String(s.waitSelector || '').trim(), ms: n(s.ms, 1000),
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(s.method || '').toUpperCase()) ? String(s.method).toUpperCase() : 'GET',
    body: s.body == null ? '' : String(s.body),
  }));
  const pattern = ['ramp', 'sustained', 'parallel'].includes(load.pattern) ? load.pattern : 'ramp';
  const maxUsers = Math.max(1, Math.floor(n(load.maxUsers, 10, 1)));
  const authModes = type === 'api' ? ['basic', 'oauth'] : ['sso', 'local'];
  return {
    id: sc.id, name: String(sc.name || 'New test').trim(), type, createdBy: sc.createdBy || '',
    proxy: String(sc.proxy == null || sc.proxy === '' ? '(connection)' : sc.proxy),
    instance: String(sc.instance || ''),
    authMode: authModes.includes(sc.authMode) ? sc.authMode : authModes[0],
    users: {
      prefix: String((sc.users || {}).prefix || '').trim(), pad: 3, firstName: String((sc.users || {}).firstName || 'Load').trim(),
      roles: prov.list((sc.users || {}).roles), groups: prov.list((sc.users || {}).groups),
    },
    steps,
    load: {
      pattern,
      // sustained and parallel
      users: Math.max(1, Math.floor(n(load.users, 5, 1))),
      durationSeconds: Math.max(10, n(load.durationSeconds, 300, 1)),
      passes: Math.max(1, Math.floor(n(load.passes, 1, 1))),
      // ramp
      startUsers: Math.min(maxUsers, Math.max(1, Math.floor(n(load.startUsers, 1, 1)))),
      stepUsers: Math.max(1, Math.floor(n(load.stepUsers, 1, 1))),
      stepSeconds: Math.max(5, n(load.stepSeconds, 60, 1)),
      maxUsers, holdSeconds: n(load.holdSeconds, 60),
      thinkMs: n(load.thinkSeconds, 3) * 1000, thinkSeconds: n(load.thinkSeconds, 3),
      sessionMode: load.sessionMode === 'relogin' ? 'relogin' : 'keep',
      entry: load.entry === 'link' ? 'link' : 'home',
      usersPerWorker: Math.max(1, Math.floor(n(load.usersPerWorker, type === 'api' ? 100 : 5, 1))),
      localWorkers: load.localWorkers === '' || load.localWorkers == null ? 'auto' : load.localWorkers,
      timeoutSeconds: Math.max(5, n(load.timeoutSeconds, 60, 1)),
    },
    limit: { p95Ms: n(limit.p95Ms, 8000), errorPct: n(limit.errorPct, 5), action: ['continue', 'pause', 'stop'].includes(limit.action) ? limit.action : 'pause' },
  };
}

// The pattern as the clock sees it: start, how it grows, where it tops out, how long it stays.
function plan(sc) {
  const l = sc.load;
  if (l.pattern === 'sustained') return { start: l.users, step: 1, stepSeconds: l.durationSeconds, max: l.users, seconds: l.durationSeconds, passes: 0 };
  if (l.pattern === 'parallel') return { start: l.users, step: 1, stepSeconds: 3600, max: l.users, seconds: 0, passes: l.passes };
  const stages = Math.ceil((l.maxUsers - l.startUsers) / l.stepUsers);
  return { start: l.startUsers, step: l.stepUsers, stepSeconds: l.stepSeconds, max: l.maxUsers, seconds: stages * l.stepSeconds + l.holdSeconds, passes: 0 };
}

function validate(sc, lim) {
  const errs = [];
  if (!sc.steps.some((s) => s.type !== 'wait')) errs.push(sc.type === 'api' ? 'Add at least one request.' : 'Add at least one link to open.');
  sc.steps.forEach((s, i) => {
    if (s.type === 'open' && !s.url) errs.push(`Step ${i + 1}: the ${sc.type === 'api' ? 'URL' : 'link'} is empty.`);
    if (['click', 'fill'].includes(s.type) && !s.selector) errs.push(`Step ${i + 1}: the selector is empty.`);
    if (sc.type === 'api' && !['open', 'wait'].includes(s.type)) errs.push(`Step ${i + 1}: an API test has requests and waits only.`);
    if (s.body) { try { JSON.parse(s.body); } catch { errs.push(`Step ${i + 1}: the body is not valid JSON.`); } }
  });
  if (!prov.NAME_RE.test(sc.users.prefix)) errs.push('Temporary user name: use 2-39 letters, digits, dot, dash or underscore.');
  if (lim) {
    const peak = plan(sc).max;
    const cap = sc.type === 'api' ? lim.maxApiUsers : lim.maxBrowsers;
    if (peak > cap) errs.push(sc.type === 'api' ? `${peak} API users is above the limit of ${cap} (Settings > Capacity).` : `${peak} browsers at once is above this machine's limit of ${cap} (Settings > Capacity). More would measure the test machine, not ServiceNow.`);
  }
  return errs;
}

class Controller {
  constructor({ port }) {
    this.port = port;
    this.run = null;
    this.secret = null;          // per run, never stored: sso key, passwords, oauth secret
    this.workers = new Map();    // name -> { name, capacity, local, lastSeen, sys, active, activity }
    this.children = [];
    this.listeners = new Set();
    this.timer = setInterval(() => this.tick().catch((e) => this.log(`Internal error: ${e.message}`)), 1000);
    this.timer.unref();
  }

  // ---- what the page sees --------------------------------------------------
  status() {
    const r = this.run;
    const now = Date.now();
    const workers = [...this.workers.values()].filter((w) => now - w.lastSeen < 15000)
      .map((w) => ({ name: w.name, host: w.host, capacity: w.capacity, local: w.local, active: w.active, cpu: w.sys.cpu, freeMb: w.sys.freeMb, totalMb: w.sys.totalMb }));
    return { run: r ? this.view(r) : null, workers, time: now };
  }
  view(r) {
    const last = r.series[r.series.length - 1];
    return {
      id: r.id, kind: r.kind, state: r.state, phase: r.phase, scenario: r.scenario, by: r.by, instance: r.instance, createdAt: r.createdAt, startedAt: r.startedAt, endedAt: r.endedAt,
      removeBy: r.createdAt + MAX_RUN_MS,
      checks: r.checks, error: r.error, log: r.log.slice(-200), users: r.users.length, target: r.target, active: r.active,
      totals: r.totals, stages: r.stages.map(({ ms, ...s }) => s), steps: r.steps.map(({ ms, ...s }) => s), series: r.series,
      speed: last && ['running', 'paused'].includes(r.state) ? { rate: last.rate, reqs: last.reqs, avg: last.avg, p95: last.p95, errors: last.errors } : null,
      limit: r.limit, shots: r.shots, trace: r.trace, advice: r.advice, cleanup: r.cleanup, ledger: r.ledger.length, idp: r.idpStats, elapsed: r.elapsed, planSeconds: r.planSeconds,
      verdict: r.verdict || '', generatorBusy: r.generatorBusy, activity: ['running', 'paused'].includes(r.state) ? this.activity() : [],
    };
  }
  activity() {
    const now = Date.now();
    return [...this.workers.values()].filter((w) => now - w.lastSeen < 6000).flatMap((w) => (w.activity || []).map((a) => ({ ...a, worker: w.name }))).sort((a, b) => a.id - b.id).slice(0, 120);
  }
  notify() { for (const fn of this.listeners) fn(); }
  log(text) {
    if (!this.run) return;
    this.run.log.push({ t: Date.now(), text });
    this.notify();
  }
  persist() { if (this.run) store.saveRun(this.run.id, { ...this.view(this.run), activity: [], log: this.run.log, ledgerRows: this.run.ledger }); }

  busy() { return !!this.run && !['done', 'failed'].includes(this.run.state); }

  // ---- start ---------------------------------------------------------------
  async start(kind, scenarioRaw, by = '') {
    if (this.busy()) throw new Error('A run is already active. Stop it first.');
    const scenario = normalize(scenarioRaw);
    const settings = store.settings();
    const errs = validate(scenario, kind === 'build' ? null : limits(settings));
    if (errs.length) throw new Error(errs.join(' '));
    const sn = SN.fromSettings(settings, scenario.instance);
    const p = plan(scenario);
    const count = kind === 'build' ? 1 : p.max;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const r = {
      id: `${stamp}-${crypto.randomBytes(2).toString('hex')}`, kind, scenario, by, instance: sn.instance, state: 'checking', phase: 'Checking the instance',
      createdAt: Date.now(), startedAt: 0, endedAt: 0, checks: [], error: '', log: [], users: [], ledger: [], target: 0, active: 0,
      totals: { n: 0, errors: 0, serverErrors: 0, requests: 0 }, stages: [], steps: [], series: [], bucket: null, limit: null, shots: [], trace: [],
      advice: [], cleanup: null, elapsed: 0, planSeconds: kind === 'build' ? 0 : p.seconds, plan: p, idpStats: null, generatorBusy: false, stopAsked: false, finished: new Set(),
    };
    this.run = r; this.sn = sn; this.secret = null;
    this.persist(); this.notify();
    this.go(r, sn, settings, count).catch((err) => this.fail(err));
    return r.id;
  }

  async go(r, sn, settings, count) {
    const sc = r.scenario;
    const api = sc.type === 'api';
    this.log(`${r.kind === 'build' ? 'Test run' : 'Load run'} "${sc.name}" against ${sn.base}${r.by ? `, started by ${r.by}` : ''}`);
    const pre = await prov.preflight(sn, sc, count);
    r.checks = pre.checks;
    if (!pre.ok) {
      r.state = 'failed'; r.phase = 'Checks failed - nothing was created on the instance'; r.endedAt = Date.now();
      r.error = pre.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | ');
      this.log(r.phase); this.persist(); return undefined;
    }
    if (r.stopAsked) return this.finish('Stopped before anything was created');

    r.state = 'provisioning'; r.phase = `Creating ${count} temporary user${count > 1 ? 's' : ''} on the instance`; this.notify();
    const idpBaseUrl = (settings.idpBaseUrl || `http://127.0.0.1:${this.port}`).replace(/\/+$/, '');
    const made = await prov.provision(sn, {
      runId: r.id, scenario: sc, count, pre, idpBaseUrl,
      ledger: (rec) => { r.ledger.push({ ...rec, t: Date.now() }); if (r.ledger.length % 10 === 1) this.persist(); },
      log: (t) => this.log(t), stop: () => r.stopAsked,
    });
    r.users = made.users; this.persist();
    this.secret = { password: made.password, sso: made.sso, oauth: made.oauth, idpBaseUrl };
    if (made.sso) idp.open({ runId: r.id, sso: made.sso, userNames: made.users.map((u) => u.name) });
    if (r.stopAsked) return this.finish('Stopped while creating users');

    r.state = 'starting'; r.phase = 'Starting workers'; this.notify();
    await this.ensureWorkers(r, settings, count);
    if (r.stopAsked) return this.finish('Stopped while starting workers');

    this.assign(r);
    const parallel = r.kind !== 'build' && sc.load.pattern === 'parallel';
    r.config = {
      type: sc.type, origin: sn.base, proxy: resolveProxy(settings, sc.proxy === '(connection)' ? (sn.instance.proxy || 'direct') : sc.proxy), authMode: sc.authMode, ssoId: made.sso ? made.sso.id : '', idpBaseUrl,
      oauth: made.oauth ? { clientId: made.oauth.clientId, clientSecret: made.oauth.clientSecret } : null,
      steps: sc.steps, thinkMs: r.kind === 'build' ? 500 : sc.load.thinkMs,
      sessionMode: sc.load.sessionMode, entry: sc.authMode === 'sso' ? sc.load.entry : 'home',
      iterations: r.kind === 'build' ? 1 : r.plan.passes, screenshots: r.kind === 'build' ? 'all' : 'errors', maxErrorShots: 6,
      // Parallel: everyone is prepared first and released in the same instant.
      startAt: parallel ? Date.now() + 8000 : 0,
      timeoutMs: sc.load.timeoutSeconds * 1000, quietMs: 700, viewport: { width: 1366, height: 768 },
      headless: settings.headless !== false, browser: settings.browser || 'chrome',
    };
    const byLink = !api && r.config.entry === 'link' && sc.steps[0].type === 'open';
    const first = api ? { index: -1, name: 'Get OAuth token', skip: sc.authMode !== 'oauth' }
      : { index: -1, name: sc.authMode === 'sso' ? 'Sign in (SSO)' : 'Sign in (local)', skip: byLink };
    r.steps = [first,
      ...sc.steps.map((s, i) => ({ index: i, name: (s.name || `${api ? s.method : s.type} ${s.url || s.selector}`.trim()) + (byLink && i === 0 ? ' (arriving: includes the SSO sign-in)' : ''), skip: s.type === 'wait' }))]
      .filter((s) => !s.skip).map(({ skip, ...s }) => ({ ...s, n: 0, errors: 0, ms: [], avg: 0, p50: 0, p95: 0, max: 0 }));
    r.state = 'running'; r.startedAt = Date.now(); r.lastTick = Date.now();
    r.phase = r.kind === 'build' ? 'Going through the steps once' : { ramp: 'Load is running: adding users step by step', sustained: 'Load is running: steady number of users', parallel: 'All users are being released at the same moment' }[sc.load.pattern];
    this.log(r.phase); this.persist();
    return undefined;
  }

  async ensureWorkers(r, settings, count) {
    const l = r.scenario.load;
    const api = r.scenario.type === 'api';
    const per = api ? Math.max(l.usersPerWorker, 25) : l.usersPerWorker;
    const cap = (w) => w.capacity * (api && !w.api ? 25 : 1);
    const alive = () => [...this.workers.values()].filter((w) => Date.now() - w.lastSeen < 6000);
    const capacity = () => alive().reduce((a, w) => a + cap(w), 0);
    let spawnN = 0;
    if (r.kind === 'build') spawnN = alive().length ? 0 : 1;
    else if (l.localWorkers === 'auto') spawnN = Math.max(0, Math.ceil((count - capacity()) / per));
    else spawnN = Math.max(0, Math.floor(Number(l.localWorkers) || 0));
    for (let i = 0; i < spawnN; i += 1) {
      const name = `local-${i + 1}`;
      const proc = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
        env: { ...process.env, UILOAD_CONTROLLER: `http://127.0.0.1:${this.port}`, UILOAD_WORKER_TOKEN: settings.workerToken, UILOAD_WORKER_NAME: name, UILOAD_WORKER_CAPACITY: String(per), UILOAD_WORKER_LOCAL: '1', UILOAD_WORKER_API: api ? '1' : '' },
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      });
      // A worker that dies, or complains, must not do so unheard.
      let said = 0;
      proc.stderr.on('data', (d) => { if (said < 20 && this.run === r) { said += 1; this.log(`[${name}] ${String(d).trim().split('\n')[0].slice(0, 300)}`); } });
      proc.on('exit', (code) => {
        if (this.run !== r || r.finishing || ['done', 'failed'].includes(r.state)) return;
        this.log(`[${name}] the worker process ended unexpectedly (exit code ${code}).`);
        if (r.kind === 'build' || this.children.every((c) => c.exitCode !== null)) this.fail(new Error(`The worker process ${name} ended unexpectedly (exit code ${code}); see the log.`)).catch(() => {});
      });
      this.children.push(proc);
    }
    if (spawnN) this.log(`Started ${spawnN} local worker${spawnN > 1 ? 's' : ''} (${per} users each)`);
    const until = Date.now() + 30000;
    while (Date.now() < until && capacity() < count && !r.stopAsked) await new Promise((s) => setTimeout(s, 300));
    if (capacity() < count) {
      if (!alive().length) throw new Error('No worker connected within 30 seconds.');
      this.log(`Warning: workers can carry ${capacity()} users, the plan asks for ${count}. Users beyond that will not start - add workers or raise "users per worker".`);
    }
    r.capOf = cap;
  }

  // Which worker runs which user: fill workers evenly, never past capacity.
  assign(r) {
    const cap = r.capOf || ((w) => w.capacity);
    const ws = [...this.workers.values()].filter((w) => Date.now() - w.lastSeen < 6000).map((w) => ({ w, n: 0, c: cap(w) }));
    r.assignment = new Map();
    r.users.forEach((u, i) => {
      const free = ws.filter((x) => x.n < x.c).sort((a, b) => a.n / a.c - b.n / b.c)[0];
      if (!free) return;
      free.n += 1;
      if (!r.assignment.has(free.w.name)) r.assignment.set(free.w.name, []);
      r.assignment.get(free.w.name).push(i);
    });
  }

  // ---- the clock -----------------------------------------------------------
  async tick() {
    const r = this.run;
    if (!r) return;
    const now = Date.now();
    // The backstop: nothing a run created outlives two hours.
    if (this.busy() && !r.stopAsked && now - r.createdAt > MAX_RUN_MS) { this.stop('The two-hour limit was reached: the run is stopped and cleaned up'); return; }
    if (!['running', 'paused'].includes(r.state)) return;
    if (r.state === 'running') r.elapsed += (now - r.lastTick) / 1000;
    r.lastTick = now;
    r.idpStats = idp.stats();
    const p = r.plan;

    if (r.kind === 'build') {
      r.target = 1;
      if (r.finished.size >= 1) { await this.finish('The test run finished'); return; }
      // One user, once: it cannot honestly need more than every step's time limit plus a margin.
      const most = (r.steps.length + 1) * (r.scenario.load.timeoutSeconds + 20) + 60;
      if (r.elapsed > most) { r.error = r.error || `The test did not finish within ${Math.round(most / 60)} minutes.`; await this.finish('The test run was given up'); return; }
    } else if (r.state === 'running') {
      const stageNo = Math.floor(r.elapsed / p.stepSeconds);
      const users = Math.min(p.max, p.start + stageNo * p.step, r.users.length);
      let st = r.stages[r.stages.length - 1];
      if (!st || st.users !== users) {
        if (st) this.closeStage(r, st);
        if (r.state !== 'running' || r.stopAsked) return;       // the limit action paused or stopped the run
        st = { users, from: r.elapsed, to: 0, n: 0, errors: 0, ms: [], avg: 0, p50: 0, p95: 0, max: 0, busy: false, breach: '' };
        r.stages.push(st);
        this.log(`${users} concurrent user${users > 1 ? 's' : ''}`);
      }
      r.target = users;
      if (p.passes) {
        // Parallel: over when every user has done its passes.
        const longest = p.passes * (r.steps.length + 1) * (r.scenario.load.timeoutSeconds + r.scenario.load.thinkSeconds) + 120;
        if (r.finished.size >= r.users.length) { this.closeStage(r, st, false); await this.finish('Every user finished'); return; }
        if (r.elapsed > longest) { this.closeStage(r, st, false); await this.finish('Some users did not finish in time'); return; }
      } else if (r.elapsed >= r.planSeconds) { this.closeStage(r, st, false); await this.finish('The plan is complete'); return; }
    }
    // A user that has sat on one thing far longer than a step may take: say so, once, while it is happening.
    const patience = (r.scenario.load.timeoutSeconds + 45) * 1000;
    r.stalled = r.stalled || new Set();
    for (const a of this.activity()) {
      const key = `${a.id}:${a.at}:${a.since}`;
      if (!a.done && a.at !== 'waiting' && now - a.since > patience && !r.stalled.has(key) && r.stalled.size < 20) { r.stalled.add(key); this.log(`${a.user} has been on "${a.at}" for ${Math.round((now - a.since) / 1000)} s without finishing it.`); }
    }
    const busy = [...this.workers.values()].some((w) => now - w.lastSeen < 6000 && w.active > 0 && w.sys.cpu >= 90);
    if (busy && r.stages.length) r.stages[r.stages.length - 1].busy = true;
    r.generatorBusy = busy;
    this.rollBucket(r, now);
    this.notify();
  }

  rollBucket(r, now) {
    if (!r.bucket) r.bucket = { t: now, ms: [], errors: 0, reqs: 0 };
    if (now - r.bucket.t < BUCKET_MS) return;
    const s = summary(r.bucket.ms);
    const secs = (now - r.bucket.t) / 1000;
    r.series.push({ t: Math.round(r.elapsed), users: r.active, n: s.n, errors: r.bucket.errors, avg: s.avg, p95: s.p95, rate: Math.round((s.n / secs) * 60), reqs: Math.round((r.bucket.reqs / secs) * 10) / 10 });
    if (r.series.length > 2000) r.series.shift();
    r.bucket = { t: now, ms: [], errors: 0, reqs: 0 };
  }

  closeStage(r, st, act = true) {
    if (st.closed) return;
    st.closed = true; st.to = r.elapsed;
    Object.assign(st, summary(st.ms));
    const lim = r.scenario.limit;
    const errPct = st.n ? (100 * st.errors) / st.n : 0;
    st.errorPct = Math.round(errPct * 10) / 10;
    if (st.n >= 5 && lim.p95Ms && st.p95 > lim.p95Ms) st.breach = `95% of steps took up to ${st.p95} ms (limit ${lim.p95Ms} ms)`;
    else if (st.n >= 5 && errPct > lim.errorPct) st.breach = `${st.errorPct}% of steps failed (limit ${lim.errorPct}%)`;
    if (st.breach && !r.limit) {
      const before = r.stages.filter((x) => x !== st && x.closed && !x.breach).pop();
      r.limit = { users: st.users, lastGood: before ? before.users : 0, reason: st.breach, generatorBusy: st.busy };
      this.log(`Limit reached at ${st.users} users: ${st.breach}.${st.busy ? ' The load generator itself was at full CPU in this stage - the limit may be the test machine, not the instance.' : ''}`);
      if (act && lim.action === 'pause') { r.state = 'paused'; r.phase = 'Paused: the limit was reached'; }
      if (act && lim.action === 'stop') this.stop('The limit was reached');
    }
    this.persist();
  }

  // ---- what workers send ----------------------------------------------------
  workerSync(body) {
    const name = String(body.name || '').slice(0, 80);
    let w = this.workers.get(name);
    if (!w) { w = { name }; this.workers.set(name, w); }
    Object.assign(w, { capacity: Number(body.capacity) || 1, local: !!body.local, api: !!body.api, host: body.host || '', lastSeen: Date.now(), sys: body.sys || {}, active: Number(body.active) || 0, activity: Array.isArray(body.activity) ? body.activity : [] });
    const r = this.run;
    if (r && body.runId === r.id && body.fatal && this.busy() && !r.finishing && !r.stopAsked) {
      // The worker cannot do its part at all (no browser). Waiting would only hide it.
      const others = [...this.workers.values()].filter((x) => x !== w && Date.now() - x.lastSeen < 6000 && x.active > 0).length;
      this.log(`[${name}] ${body.fatal}`);
      if (r.kind === 'build' || !others) this.fail(new Error(`${body.fatal} Check the browser under Administration > Capacity and workers.`)).catch(() => {});
    }
    if (r && body.runId === r.id) {
      for (const s of body.samples || []) this.sample(r, s);
      for (const sh of body.shots || []) this.shot(r, sh);
      for (const t of body.traces || []) if (r.trace.length < 200) r.trace.push(t);
      for (const id of body.finished || []) r.finished.add(id);
      for (const t of body.log || []) this.log(`[${name}] ${t}`);
    }
    if (r) r.active = [...this.workers.values()].filter((x) => Date.now() - x.lastSeen < 6000).reduce((a, x) => a + x.active, 0);
    if (!r || !['running', 'paused'].includes(r.state) || !r.assignment) return { state: r && r.state === 'stopping' ? 'stopped' : 'idle' };
    const mine = (r.assignment.get(name) || []).filter((i) => i < r.target);
    return {
      runId: r.id, state: r.state, config: r.config,
      vus: mine.map((i) => ({ id: i, user: r.users[i].name, password: this.secret.password || undefined, ticket: this.secret.sso ? idp.ticket(r.users[i].name) : undefined })),
    };
  }

  sample(r, s) {
    const ms = Number(s.ms) || 0;
    r.totals.n += 1; r.totals.serverErrors += Number(s.serverErrors) || 0; r.totals.requests += Number(s.requests) || 0;
    if (!s.ok) r.totals.errors += 1;
    const step = r.steps.find((x) => x.index === s.step);
    if (step) {
      step.n += 1; if (!s.ok) { step.errors += 1; step.lastError = s.error; if (Array.isArray(s.path)) { step.lastPath = s.path.slice(0, 14).map((p) => String(p).slice(0, 160)); step.lastCookies = Array.isArray(s.cookies) ? s.cookies.slice(0, 14).map((c) => String(c).slice(0, 60)) : null; } }
      step.ms.push(ms);
      if (step.n % 5 === 0 || step.n < 20) Object.assign(step, summary(step.ms));
    }
    const st = r.stages[r.stages.length - 1];
    if (st && !st.closed) { st.n += 1; if (!s.ok) st.errors += 1; st.ms.push(ms); if (st.n % 5 === 0) Object.assign(st, summary(st.ms)); }
    if (r.bucket) { r.bucket.ms.push(ms); r.bucket.reqs += Number(s.requests) || 0; if (!s.ok) r.bucket.errors += 1; }
  }

  shot(r, sh) {
    if (r.shots.length >= 200) return;
    const file = `${String(r.shots.length + 1).padStart(3, '0')}.jpg`;
    store.saveShot(r.id, file, Buffer.from(sh.jpeg, 'base64'));
    r.shots.push({ file, step: sh.step, name: sh.name, ok: sh.ok, ms: sh.ms, url: sh.url, error: sh.error, user: sh.user, t: sh.t });
    this.notify();
  }

  // ---- pause, resume, stop ---------------------------------------------------
  pause() {
    const r = this.run;
    if (!r || r.state !== 'running') throw new Error('No run is running.');
    r.state = 'paused'; r.phase = 'Paused: users finish the step they are on and wait'; this.log('Paused');
  }
  resume() {
    const r = this.run;
    if (!r || r.state !== 'paused') throw new Error('The run is not paused.');
    r.state = 'running'; r.lastTick = Date.now(); r.phase = 'Load is running'; this.log('Resumed');
  }
  stop(why = 'Stop requested') {
    const r = this.run;
    if (!r || !this.busy()) throw new Error('No run is active.');
    if (r.stopAsked) return;
    r.stopAsked = true; r.stopAskedByUser = /^Stopped by /.test(why);
    this.log(why);
    if (['running', 'paused'].includes(r.state)) this.finish(why).catch((e) => this.fail(e));
  }

  async fail(err) {
    const r = this.run;
    if (!r) return;
    r.error = err.message;
    this.log(`Failed: ${err.message}`);
    await this.finish('The run failed', true);
  }

  // Ends the load, then removes from the instance everything the run created.
  async finish(why, failed = false) {
    const r = this.run;
    if (!r || r.finishing) return;
    r.finishing = true;
    const last = r.stages[r.stages.length - 1];
    if (last && !last.closed) this.closeStage(r, last, false);
    for (const s of r.steps) Object.assign(s, summary(s.ms));
    r.state = 'stopping'; r.phase = `${why} - closing ${r.scenario.type === 'api' ? 'connections' : 'browsers'}`; r.target = 0; this.notify();
    const until = Date.now() + 15000;
    while (Date.now() < until && [...this.workers.values()].some((w) => Date.now() - w.lastSeen < 4000 && w.active > 0)) await new Promise((s) => setTimeout(s, 300));
    for (const p of this.children.splice(0)) { try { p.kill(); } catch { /* gone */ } }
    for (const [name, w] of this.workers) if (w.local) this.workers.delete(name);
    idp.close(); this.secret = null; r.active = 0;
    // Failures: look on the instance for the reason while its logs are fresh.
    if (r.totals.errors || r.error) {
      r.phase = `${why} - looking on the instance for why steps failed`; this.notify();
      try { r.advice = await Promise.race([diagnose(this.sn, r), new Promise((s) => setTimeout(() => s([]), 25000))]); } catch { r.advice = []; }
      for (const a of r.advice) this.log(`Finding: ${a.title}`);
    }
    r.phase = `${why} - removing what the run created on the instance`; this.notify();
    await this.clean(r);
    r.endedAt = Date.now();
    // The verdict, in words. A run in which nothing ran is a failure, not a result.
    const t = r.totals;
    const reached = !!r.startedAt;
    if (reached && !t.n && !r.stopAskedByUser) { failed = true; r.error = r.error || 'No step ran at all. The users never got as far as the first step - the log below says where it stopped.'; }
    if (r.kind === 'build' && t.n) {
      if (t.errors) { failed = true; r.error = r.error || `The test did not pass: ${t.errors} of ${t.n} step${t.n === 1 ? '' : 's'} failed.`; }
      r.verdict = t.errors ? 'failed' : 'passed';
    } else r.verdict = failed ? 'failed' : (r.kind === 'build' ? 'failed' : 'completed');
    r.state = failed ? 'failed' : 'done';
    const outcome = r.kind === 'build' ? (r.verdict === 'passed' ? `The test PASSED: ${t.n} step${t.n === 1 ? '' : 's'}, none failed` : 'The test FAILED') : why;
    r.phase = r.cleanup.complete ? `${outcome}. Everything created for the run has been removed.` : `${outcome}. CLEANUP IS NOT COMPLETE - it will be tried again automatically.`;
    this.log(r.phase); this.persist(); this.notify();
  }

  async clean(r) {
    try {
      r.cleanup = await prov.cleanup(this.sn, { runId: r.id, ledger: r.ledger, log: (t) => this.log(t) });
    } catch (err) {
      r.cleanup = { deleted: 0, failed: [{ label: 'cleanup', error: err.message }], remaining: r.ledger, complete: false, at: Date.now() };
      this.log(`Cleanup failed: ${err.message}`);
    }
  }
}

// Cleanup of a stored run (after a crash, or when the first attempt was incomplete).
async function cleanStored(id, how = '') {
  const saved = store.readRun(id);
  if (!saved) throw new Error('No such run.');
  const log = [];
  const res = await prov.cleanup(SN.fromSettings(store.settings(), saved.instance && saved.instance.id), { runId: id, ledger: saved.ledgerRows || [], log: (t) => log.push({ t: Date.now(), text: `${how ? `[${how}] ` : ''}${t}` }) });
  saved.cleanup = res; saved.log = [...(saved.log || []), ...log];
  if (!['done', 'failed'].includes(saved.state)) { saved.state = 'failed'; saved.phase = 'Interrupted (the app was closed during the run)'; saved.endedAt = saved.endedAt || Date.now(); }
  store.saveRun(id, saved);
  return res;
}

// The janitor: any stored run that may still have records on the instance is
// cleaned without anyone asking - at once when it was interrupted, and again
// every few minutes until the instance is confirmed empty of it.
async function janitor(activeId) {
  const done = [];
  for (const r of store.listRuns()) {
    if (r.id === activeId) continue;
    const pending = (r.ledger || (r.ledgerRows || []).length) && (!r.cleanup || !r.cleanup.complete);
    if (!pending) continue;
    try { const res = await cleanStored(r.id, 'automatic cleanup'); done.push({ id: r.id, complete: res.complete }); } catch (err) { done.push({ id: r.id, complete: false, error: err.message }); }
  }
  return done;
}

// What each run created on the instance and whether it is still there.
function records(activeRun) {
  return store.listRuns().map((r) => {
    const rows = r.ledgerRows || [];
    const byTable = {};
    for (const x of rows) byTable[x.table] = (byTable[x.table] || 0) + 1;
    const active = activeRun && activeRun.id === r.id && !['done', 'failed'].includes(activeRun.state);
    const state = !rows.length ? 'nothing' : (r.cleanup && r.cleanup.complete) ? 'removed' : active ? 'in use' : 'left';
    return { id: r.id, name: r.scenario && r.scenario.name, kind: r.kind, by: r.by || '', instance: r.instance ? r.instance.name : '', instanceId: r.instance ? r.instance.id : '', createdAt: r.createdAt, total: rows.length, byTable, state,
      removedAt: r.cleanup && r.cleanup.complete ? r.cleanup.at || r.endedAt : 0, removeBy: r.createdAt + MAX_RUN_MS,
      remaining: r.cleanup && !r.cleanup.complete ? (r.cleanup.remaining || []).length : 0, error: r.cleanup && r.cleanup.failed && r.cleanup.failed[0] ? r.cleanup.failed[0].error : '' };
  });
}

module.exports = { Controller, normalize, validate, plan, summary, cleanStored, janitor, records, limits, hostInfo, MAX_RUN_MS };
