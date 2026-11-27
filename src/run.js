'use strict';
// The run controller: one run at a time, from checks to cleanup.
//
//   checking -> provisioning -> starting -> running <-> paused -> stopping -> done
//
// A validation run ("Test" on the page) is the same thing with one user, one
// pass and a screenshot (UI) or the answer (API) for every step. Stop - asked
// for, reached by the end of the plan, forced by a failure or by the two-hour
// limit - always ends in cleanup of what the run created on the instance.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { SN } = require('./sn');
const prov = require('./provision');
const idp = require('./idp');
const store = require('./store');
const { resolveProxy } = require('./http');
const replay = require('./replay');
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
  const load = { ...(sc.load || {}) };
  const limit = { ...(sc.limit || {}) };
  const type = sc.type === 'api' ? 'api' : 'ui';
  const steps = (sc.steps || []).filter((s) => s && s.type).map((s) => ({
    type: s.type, name: String(s.name || '').trim(), url: String(s.url || '').trim(), selector: String(s.selector || '').trim(),
    value: s.value == null ? '' : String(s.value), enter: !!s.enter, waitSelector: String(s.waitSelector || '').trim(), ms: n(s.ms, 1000),
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(s.method || '').toUpperCase()) ? String(s.method).toUpperCase() : 'GET',
    body: s.body == null ? '' : String(s.body),
  }));
  // Simple setup: one of three questions and a number or two; the pattern is worked out from them.
  const mode = type !== 'api' && load.mode === 'simple' ? 'simple' : 'advanced';
  const question = ['sustain', 'surge', 'parallel'].includes(load.question) ? load.question : 'sustain';
  const qUsers = Math.max(1, Math.floor(n(load.qUsers, 20, 1)));
  const qMinutes = Math.max(1, n(load.qMinutes, 10, 1));
  const qPeople = Math.max(1, Math.floor(n(load.qPeople, 1000, 1)));
  const visitSeconds = Math.max(5, n(load.visitSeconds, 30, 1));
  const simple = mode === 'simple' ? simplePlan({ question, users: qUsers, minutes: qMinutes, people: qPeople, visitSeconds }) : null;
  if (simple) { Object.assign(load, simple); limit.action = simple.action; }
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
      mode, question, qUsers, qMinutes, qPeople, visitSeconds,
      // Who carries the load of a browser test: real browsers, lightweight users (the recorded requests), or
      // whichever fits - browsers while this machine can drive that many, lightweight users beyond.
      engine: type === 'api' ? 'browser' : ['browser', 'http'].includes(load.engine) ? load.engine : 'auto',
      // Real browsers that go through the same steps during a lightweight run, to show what a person would see.
      probes: type === 'api' ? 0 : Math.min(5, Math.max(0, Math.floor(n(load.probes, 2)))),
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

// 'ui' browsers, 'http' lightweight users, 'api'.
function engineOf(sc, lim) {
  if (sc.type === 'api') return 'api';
  if (sc.load.engine === 'http') return 'http';
  if (sc.load.engine === 'browser' || !lim) return 'ui';
  return plan(sc).max > lim.maxBrowsers ? 'http' : 'ui';
}
function recordingOf(sc) {
  const rec = sc.id ? store.read(`recording-${sc.id}.json`, null) : null;
  return rec && rec.key === replay.stepsKey(sc.steps) ? rec : null;
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
    const eng = engineOf(sc, lim);
    const cap = eng === 'ui' ? lim.maxBrowsers : lim.maxApiUsers;
    if (peak > cap) errs.push(eng === 'api' ? `${peak} API users is above the limit of ${cap} (Capacity and workers).` : eng === 'http' ? `${peak} lightweight users at the same moment is above the limit of ${cap} (Capacity and workers: "Most API users at once").` : `${peak} browsers at once is above this machine's limit of ${cap} (Capacity and workers). More would measure the test machine, not ServiceNow. Choose lightweight users for this many.`);
    if (eng === 'http') {
      if (sc.authMode !== 'sso') errs.push('Lightweight users sign in through Mock SSO only. Choose Mock SSO under Test users, or use real browsers.');
      if (!recordingOf(sc)) errs.push(`This test needs ${peak} users at the same moment, more than the ${lim.maxBrowsers} browsers this machine can drive, so it runs with lightweight users - and those repeat what a browser did. Press "Test (1 user, once)" first: a passing test run records it. (After changing a step, test again.)`);
    }
  }
  return errs;
}

// ---- the three questions of the simple setup --------------------------------
// Someone who is not a tester asks one of these, with one or two numbers:
//   sustain  - can the instance carry X people doing this for M minutes?
//   surge    - P people (the company) click within M minutes: can it take that?
//   parallel - how many people can do this at the same moment?
// Each becomes one of the load patterns. `visit` is how long one person's visit
// takes (measured by the last test run), which turns "P people in M minutes"
// into "so many at the same moment".
function simplePlan(q) {
  const visit = Math.max(5, Number(q.visitSeconds) || 30);
  const users = Math.max(1, Math.floor(Number(q.users) || 1));
  const minutes = Math.max(1, Number(q.minutes) || 10);
  const stepSeconds = Math.max(30, Math.ceil((visit * 2) / 10) * 10);
  if (q.question === 'surge') {
    const people = Math.max(1, Math.floor(Number(q.people) || 1));
    const together = Math.max(1, Math.ceil((people * visit) / (minutes * 60)));
    const stepUsers = Math.max(1, Math.ceil(together / 5));
    const rampSeconds = Math.ceil((together - stepUsers) / stepUsers) * stepSeconds;
    return { pattern: 'ramp', startUsers: stepUsers, stepUsers, stepSeconds, maxUsers: together, holdSeconds: Math.max(60, Math.round(minutes * 60 - rampSeconds)), sessionMode: 'relogin', together, people, minutes, action: 'stop' };
  }
  if (q.question === 'parallel') {
    const stepUsers = Math.max(1, Math.ceil(users / 10));
    return { pattern: 'ramp', startUsers: stepUsers, stepUsers, stepSeconds, maxUsers: users, holdSeconds: 60, sessionMode: 'keep', action: 'stop' };
  }
  return { pattern: 'sustained', users, durationSeconds: Math.round(minutes * 60), sessionMode: 'keep', action: 'continue' };
}

// When the measured numbers first crossed the line the test set, from the time series.
function firstTrouble(series, limit) {
  let streak = 0;
  for (const p of series || []) {
    const errPct = p.n ? (100 * p.errors) / p.n : 0;
    const slow = limit.p95Ms && p.n >= 3 && p.p95 > limit.p95Ms;
    const failing = p.n >= 3 && errPct > limit.errorPct;
    if (slow || failing) {
      streak += 1;
      // Two measurements in a row: one slow moment is not trouble.
      if (streak >= 2) return { t: p.t, users: p.users, why: failing ? `${Math.round(errPct)}% of steps failed` : `95% of steps took up to ${(p.p95 / 1000).toFixed(1)} s` };
    } else streak = 0;
  }
  return null;
}

const dur = (sec) => { const s = Math.round(sec); return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 120 ? `${Math.round(s / 60)} minutes` : s >= 60 ? `1 min ${s - 60} s` : `${s} seconds`; };
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// The result as an answer to the question that was asked. No verdict is given for a run that did not really run.
function answer(r) {
  const sc = r.scenario; const l = sc.load; const t = r.totals;
  if (r.kind !== 'load' || !t.n) return null;
  const all = r.steps.flatMap((s) => s.ms || []);
  const sum = summary(all);
  const errPct = Math.round((1000 * t.errors) / t.n) / 10;
  const peak = Math.max(0, ...r.stages.map((s) => s.users));
  const trouble = firstTrouble(r.series, sc.limit);
  const what = r.engine === 'http' ? 'lightweight users (recorded requests, no browser)' : sc.type === 'api' ? 'API users' : 'real browsers';
  const facts = [
    `${t.n} steps were done by up to ${peak} ${what} at the same moment; ${t.errors} failed (${errPct}%).`,
    `A step typically took ${secs(sum.p50)}; 95% took ${secs(sum.p95)} or less; the slowest ${secs(sum.max)}.`,
    `"Too slow" for this test means 95% of steps slower than ${secs(sc.limit.p95Ms)}, or more than ${sc.limit.errorPct}% failing.`,
  ];
  const seen = r.stages.filter((s) => s.browser && s.browser.n);
  if (r.probe && seen.length) {
    const first = seen[0]; const last = seen[seen.length - 1];
    facts.push(seen.length > 1 && last !== first
      ? `What a person would have seen, measured by ${r.probes} real browser${r.probes > 1 ? 's' : ''} during the run: a step took typically ${secs(first.browser.p50)} with ${first.users} people on, and ${secs(last.browser.p50)} with ${last.users} (95% within ${secs(last.browser.p95)}).${r.probe.errors ? ` ${r.probe.errors} of the browsers' ${r.probe.n} steps failed.` : ''}`
      : `What a person would have seen, measured by ${r.probes} real browser${r.probes > 1 ? 's' : ''} during the run: a step took typically ${secs(last.browser.p50)}, and 95% within ${secs(last.browser.p95)}.${r.probe.errors ? ` ${r.probe.errors} of the browsers' ${r.probe.n} steps failed.` : ''}`);
    facts.push('The other times are how long ServiceNow took to answer the lightweight users; a browser adds the time to draw the page, which the line above includes.');
  } else if (r.engine === 'http') facts.push(r.probe && r.probe.n ? `The ${r.probes} real browser${r.probes > 1 ? 's' : ''} measuring alongside finished no step successfully (${r.probe.errors} failed), so there is no figure for what a person would have seen.` : 'These times are how long ServiceNow took to answer. The time a browser needs to draw the page comes on top; a Test run with one browser shows that.');
  const stopped = r.stopAskedByUser ? ' The run was stopped by hand before the plan was complete.' : '';
  const machine = r.limit && r.limit.generatorBusy ? ' The test machine itself was at full CPU at that point, so this may be the test machine and not ServiceNow: repeat with ' + (r.engine === 'http' ? 'a worker on a stronger machine, or more worker machines' : 'lightweight users, or more worker machines') + '.' : '';
  const q = l.mode === 'simple' ? l.question : l.pattern === 'sustained' ? 'sustain' : 'parallel';
  let ok; let headline;
  if (q === 'sustain') {
    const ran = dur(r.elapsed);
    if (trouble) { ok = false; headline = `No. ${l.users} people were not carried for the whole time: trouble began after ${dur(trouble.t)} (${trouble.why}).`; }
    else { ok = !r.limit; headline = r.limit ? `Not cleanly. ${l.users} people ran for ${ran}, but over the whole run ${r.limit.reason}.` : `Yes. ${l.users} people at the same time were carried for ${ran} without trouble.`; }
  } else if (q === 'surge') {
    const s = simplePlan({ question: 'surge', people: l.qPeople, minutes: l.qMinutes, visitSeconds: l.visitSeconds });
    if (r.limit) {
      const good = r.limit.lastGood;
      const people = Math.floor((s.people * good) / s.together);
      ok = false;
      headline = good
        ? `No. The instance coped with about ${people.toLocaleString('en')} of the ${s.people.toLocaleString('en')} people arriving within ${s.minutes} minutes (${good} at the same moment). At ${r.limit.users} at the same moment trouble began: ${r.limit.reason}.`
        : `No. Trouble began at the first level, ${r.limit.users} people at the same moment: ${r.limit.reason}.`;
    } else { ok = peak >= s.together; headline = ok ? `Yes. ${s.people.toLocaleString('en')} people arriving within ${s.minutes} minutes were carried: that is ${s.together} at the same moment, and no trouble was seen.` : `Not decided: the run ended at ${peak} at the same moment, before reaching the ${s.together} that ${s.people.toLocaleString('en')} people in ${s.minutes} minutes need.`; }
  } else if (r.limit) {
    ok = false;
    headline = r.limit.lastGood ? `About ${r.limit.lastGood} people at the same moment. At ${r.limit.users} trouble began: ${r.limit.reason}.` : `Fewer than ${r.limit.users} people at the same moment: trouble began at the first level (${r.limit.reason}).`;
  } else { ok = true; headline = `At least ${peak} people at the same moment: no trouble was seen up to there. The limit lies higher - try a larger number.`; }
  return { ok, question: q, headline: headline + machine + stopped, facts, trouble };
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
      totals: r.totals, stages: r.stages.map(({ ms, browserMs, ...s }) => s), probes: r.probes || 0, probe: r.probe ? { n: r.probe.n, errors: r.probe.errors, steps: r.probe.steps.map(({ ms, ...s }) => s) } : null, steps: r.steps.map(({ ms, ...s }) => s), series: r.series,
      speed: last && ['running', 'paused'].includes(r.state) ? { rate: last.rate, reqs: last.reqs, avg: last.avg, p95: last.p95, errors: last.errors } : null,
      limit: r.limit, shots: r.shots, trace: r.trace, advice: r.advice, cleanup: r.cleanup, ledger: r.ledger.length, idp: r.idpStats, elapsed: r.elapsed, planSeconds: r.planSeconds,
      verdict: r.verdict || '', generatorBusy: r.generatorBusy, engine: r.engine, answer: r.answer || null, activity: ['running', 'paused'].includes(r.state) ? this.activity() : [],
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
    const lim = limits(settings);
    const errs = validate(scenario, kind === 'build' ? null : lim);
    if (errs.length) throw new Error(errs.join(' '));
    const sn = SN.fromSettings(settings, scenario.instance);
    const p = plan(scenario);
    const light = kind === 'build' ? 1 : p.max;
    // Lightweight run: a few real browsers measure alongside, never more than this machine can drive.
    const probes = kind !== 'build' && engineOf(scenario, lim) === 'http' ? Math.min(scenario.load.probes, lim.maxBrowsers) : 0;
    const count = light + probes;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const r = {
      id: `${stamp}-${crypto.randomBytes(2).toString('hex')}`, kind, scenario, by, instance: sn.instance, state: 'checking', phase: 'Checking the instance',
      createdAt: Date.now(), startedAt: 0, endedAt: 0, checks: [], error: '', log: [], users: [], ledger: [], target: 0, active: 0,
      totals: { n: 0, errors: 0, serverErrors: 0, requests: 0 }, stages: [], steps: [], series: [], bucket: null, limit: null, shots: [], trace: [],
      advice: [], cleanup: null, elapsed: 0, planSeconds: kind === 'build' ? 0 : p.seconds, plan: p, idpStats: null, engine: kind === 'build' ? (scenario.type === 'api' ? 'api' : 'ui') : engineOf(scenario, lim), recorded: [], answer: null, light, probes, probe: null, generatorBusy: false, stopAsked: false, finished: new Set(),
    };
    this.run = r; this.sn = sn; this.secret = null;
    this.persist(); this.notify();
    this.go(r, sn, settings, count).catch((err) => this.fail(err));
    return r.id;
  }

  async go(r, sn, settings, count) {
    const sc = r.scenario;
    const api = sc.type === 'api';
    const http = r.engine === 'http';
    this.log(`${r.kind === 'build' ? 'Test run' : 'Load run'} "${sc.name}" against ${sn.base}${r.by ? `, started by ${r.by}` : ''}`);
    if (r.probes) this.log(`${r.probes} real browser${r.probes > 1 ? 's go' : ' goes'} through the same steps during the whole run, to measure what a person would see. Their times are shown apart and do not count towards the limit.`);
    if (http) this.log('Running with lightweight users: each sends the requests a browser made in the last test run, with its own session. No browser is opened.');
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
    r.ssoId = made.sso ? made.sso.id : '';
    if (made.sso) idp.open({ runId: r.id, sso: made.sso, userNames: made.users.map((u) => u.name) });
    if (r.stopAsked) return this.finish('Stopped while creating users');

    r.state = 'starting'; r.phase = 'Starting workers'; this.notify();
    await this.ensureWorkers(r, settings, count);
    if (r.stopAsked) return this.finish('Stopped while starting workers');

    this.assign(r);
    const parallel = r.kind !== 'build' && sc.load.pattern === 'parallel';
    r.config = {
      type: http ? 'http' : sc.type, probes: r.probes, origin: sn.base, recording: http ? recordingOf(sc) : null, record: r.kind === 'build' && !api, proxy: resolveProxy(settings, sc.proxy === '(connection)' ? (sn.instance.proxy || 'direct') : sc.proxy), authMode: sc.authMode, ssoId: made.sso ? made.sso.id : '', idpBaseUrl,
      oauth: made.oauth ? { clientId: made.oauth.clientId, clientSecret: made.oauth.clientSecret } : null,
      steps: sc.steps, thinkMs: r.kind === 'build' ? 500 : sc.load.thinkMs,
      sessionMode: sc.load.sessionMode, entry: sc.authMode === 'sso' ? sc.load.entry : 'home',
      iterations: r.kind === 'build' ? 1 : r.plan.passes, screenshots: r.kind === 'build' ? 'all' : 'errors', maxErrorShots: http ? 12 : 6,
      // Parallel: everyone is prepared first and released in the same instant.
      startAt: parallel ? Date.now() + 8000 : 0,
      // Otherwise the users of a level arrive spread over its first half (at most 30 s), as people do.
      spreadMs: parallel || r.kind === 'build' ? 0 : Math.min(30000, r.plan.stepSeconds * 500),
      timeoutMs: sc.load.timeoutSeconds * 1000, quietMs: 700, viewport: { width: 1366, height: 768 },
      headless: settings.headless !== false, browser: settings.browser || 'chrome',
    };
    const byLink = !api && r.config.entry === 'link' && sc.steps[0].type === 'open';
    const first = api ? { index: -1, name: 'Get OAuth token', skip: sc.authMode !== 'oauth' }
      : { index: -1, name: sc.authMode === 'sso' ? 'Sign in (SSO)' : 'Sign in (local)', skip: byLink };
    r.steps = [first,
      ...sc.steps.map((s, i) => ({ index: i, name: (s.name || `${api ? s.method : s.type} ${s.url || s.selector}`.trim()) + (byLink && i === 0 ? ' (arriving: includes the SSO sign-in)' : ''), skip: s.type === 'wait' }))]
      .filter((s) => !s.skip).map(({ skip, ...s }) => ({ ...s, n: 0, errors: 0, ms: [], avg: 0, p50: 0, p95: 0, max: 0 }));
    // The measuring browsers' own results, step by step.
    if (r.probes) r.probe = { n: 0, errors: 0, steps: r.steps.map((s) => ({ index: s.index, name: s.name, n: 0, errors: 0, ms: [], avg: 0, p50: 0, p95: 0, max: 0, lastError: '' })) };
    r.state = 'running'; r.startedAt = Date.now(); r.lastTick = Date.now();
    r.phase = r.kind === 'build' ? 'Going through the steps once' : { ramp: 'Load is running: adding users step by step', sustained: 'Load is running: steady number of users', parallel: 'All users are being released at the same moment' }[sc.load.pattern];
    this.log(r.phase); this.persist();
    return undefined;
  }

  async ensureWorkers(r, settings, count) {
    const l = r.scenario.load;
    const api = r.scenario.type === 'api' || r.engine === 'http';
    const per = api ? Math.max(r.engine === 'http' ? 250 : l.usersPerWorker, 25) : l.usersPerWorker;
    const cap = (w) => w.capacity * (api && !w.api ? 25 : 1);
    const alive = () => [...this.workers.values()].filter((w) => Date.now() - w.lastSeen < 6000);
    const capacity = () => alive().reduce((a, w) => a + cap(w), 0);
    let spawnN = 0;
    if (r.kind === 'build') spawnN = alive().length ? 0 : 1;
    else if (l.localWorkers === 'auto') spawnN = Math.max(0, Math.ceil((count - capacity()) / per));
    else spawnN = Math.max(0, Math.floor(Number(l.localWorkers) || 0));
    const startOne = (name) => {
      // What the worker writes as it fails goes to a file: written through a pipe, the last words of a process that
      // dies abruptly are lost, and they are the ones that matter.
      const logFile = path.join(store.DATA, 'runs', r.id, `worker-${name}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const fd = fs.openSync(logFile, 'a');
      const proc = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
        env: { ...process.env, UILOAD_CONTROLLER: `http://127.0.0.1:${this.port}`, UILOAD_WORKER_TOKEN: settings.workerToken, UILOAD_WORKER_NAME: name, UILOAD_WORKER_CAPACITY: String(per), UILOAD_WORKER_LOCAL: '1', UILOAD_WORKER_API: api ? '1' : '' },
        stdio: ['ignore', 'ignore', fd], windowsHide: true,
      });
      fs.closeSync(fd);
      // A worker that dies, or complains, must not do so unheard: its file is read as it grows.
      let at = 0; let said = 0;
      const tell = () => {
        let text = '';
        try { const all = fs.readFileSync(logFile, 'utf8'); text = all.slice(at); at = all.length; } catch { return; }
        for (const line of text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) if (said < 30 && this.run === r && !/^\(Use `node --trace-warnings|TimeoutNegativeWarning|^Timeout duration was set to/.test(line)) { said += 1; this.log(`[${name}] ${line.slice(0, 300)}`); }
      };
      const watch = setInterval(tell, 3000); watch.unref();
      proc.on('exit', (code) => {
        clearInterval(watch); tell();
        if (this.run !== r || r.finishing || ['done', 'failed'].includes(r.state)) return;
        this.log(`[${name}] the worker process ended unexpectedly (exit code ${code}).`);
        // A load run does not end because one worker process died: it is started again, takes the same users back,
        // and they sign in again. Three times; a worker that keeps dying is a fault to look at, not to hide.
        r.restarts = (r.restarts || 0) + 1;
        if (r.kind !== 'build' && r.restarts <= 3 && !r.stopAsked) {
          this.log(`Starting ${name} again (${r.restarts} of 3). Its users sign in again; what they were doing at that moment is lost, and this stretch of the run is less reliable.`);
          this.children = this.children.filter((c) => c !== proc);
          startOne(name);
          return;
        }
        if (r.kind === 'build' || this.children.every((c) => c.exitCode !== null)) this.fail(new Error(`The worker process ${name} ended unexpectedly (exit code ${code})${r.restarts > 3 ? ', also after being started again 3 times' : ''}; see the log.`)).catch(() => {});
      });
      this.children.push(proc);
    };
    for (let i = 0; i < spawnN; i += 1) startOne(`local-${i + 1}`);
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
    const light = r.light == null ? r.users.length : r.light;
    const home = ws.find((x) => x.w.local) || ws[0];
    r.users.forEach((u, i) => {
      const free = i >= light ? home : ws.filter((x) => x.n < x.c).sort((a, b) => a.n / a.c - b.n / b.c)[0];
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
      const users = Math.min(p.max, p.start + stageNo * p.step, r.light == null ? r.users.length : Math.min(r.light, r.users.length));
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
        if ([...r.finished].filter((id) => id < (r.light == null ? Infinity : r.light)).length >= Math.min(r.users.length, r.light == null ? Infinity : r.light)) { this.closeStage(r, st, false); await this.finish('Every user finished'); return; }
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
    if (!r.bucket) r.bucket = { t: now, ms: [], errors: 0, reqs: 0, browserMs: [], browserErrors: 0 };
    if (now - r.bucket.t < BUCKET_MS) return;
    const s = summary(r.bucket.ms);
    const secs = (now - r.bucket.t) / 1000;
    const bs = r.probes && r.bucket.browserMs.length ? summary(r.bucket.browserMs) : null;
    r.series.push({ ...(r.probes ? { browser: bs ? bs.p50 : 0, browserN: bs ? bs.n : 0, browserErrors: r.bucket.browserErrors } : {}), t: Math.round(r.elapsed), users: Math.max(0, r.active - (r.probes || 0)), n: s.n, errors: r.bucket.errors, avg: s.avg, p95: s.p95, rate: Math.round((s.n / secs) * 60), reqs: Math.round((r.bucket.reqs / secs) * 10) / 10 });
    if (r.series.length > 2000) r.series.shift();
    r.bucket = { t: now, ms: [], errors: 0, reqs: 0, browserMs: [], browserErrors: 0 };
  }

  closeStage(r, st, act = true) {
    if (st.closed) return;
    st.closed = true; st.to = r.elapsed;
    Object.assign(st, summary(st.ms));
    if (st.browserMs && st.browserMs.length) { const b = summary(st.browserMs); st.browser = { n: b.n, p50: b.p50, p95: b.p95 }; }
    const lim = r.scenario.limit;
    const errPct = st.n ? (100 * st.errors) / st.n : 0;
    st.errorPct = Math.round(errPct * 10) / 10;
    if (st.n >= 5 && lim.p95Ms && st.p95 > lim.p95Ms) st.breach = `95% of steps took up to ${(st.p95 / 1000).toFixed(1)} s (the line is ${(lim.p95Ms / 1000).toFixed(1)} s)`;
    else if (st.n >= 5 && errPct > lim.errorPct) st.breach = `${st.errorPct}% of steps failed (the line is ${lim.errorPct}%)`;
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
      if (r.kind === 'build' && r.recorded) for (const st of body.recording || []) if (r.recorded.length < 200) r.recorded.push(st);
      for (const t of body.log || []) this.log(`[${name}] ${t}`);
    }
    if (r) r.active = [...this.workers.values()].filter((x) => Date.now() - x.lastSeen < 6000).reduce((a, x) => a + x.active, 0);
    if (!r || !['running', 'paused'].includes(r.state) || !r.assignment) return { state: r && r.state === 'stopping' ? 'stopped' : 'idle' };
    // The measuring browsers (the users after the lightweight ones) run from the start to the end, whatever the level.
    const light = r.light == null ? Infinity : r.light;
    const mine = (r.assignment.get(name) || []).filter((i) => i < r.target || (i >= light && i < r.users.length));
    return {
      runId: r.id, state: r.state, config: r.config,
      vus: mine.map((i) => ({ id: i, kind: i >= light ? 'browser' : undefined, user: r.users[i].name, userId: r.users[i].id, password: this.secret.password || undefined, ticket: this.secret.sso ? idp.ticket(r.users[i].name) : undefined })),
    };
  }

  sample(r, s) {
    const ms = Number(s.ms) || 0;
    if (r.probe && r.light != null && Number(s.vu) >= r.light) {
      // What a person would see: timed in a real browser while the lightweight users make the load.
      const p = r.probe;
      p.n += 1; if (!s.ok) p.errors += 1;
      const row = p.steps.find((x) => x.index === s.step);
      if (row) { row.n += 1; if (!s.ok) { row.errors += 1; row.lastError = s.error; } else row.ms.push(ms); if (row.n < 20 || row.n % 5 === 0) Object.assign(row, summary(row.ms)); }
      // A first arrival of a browser that then stays signed in is not what a page takes under load.
      const once = s.arrival && r.config && r.config.sessionMode === 'keep';
      if (s.ok && !once) {
        const st = r.stages[r.stages.length - 1];
        if (st && !st.closed) (st.browserMs = st.browserMs || []).push(ms);
        if (r.bucket) r.bucket.browserMs.push(ms);
      }
      if (!s.ok && r.bucket) r.bucket.browserErrors += 1;
      return;
    }
    r.totals.n += 1; r.totals.serverErrors += Number(s.serverErrors) || 0; r.totals.requests += Number(s.requests) || 0;
    if (!s.ok) r.totals.errors += 1;
    const step = r.steps.find((x) => x.index === s.step);
    if (step) {
      step.n += 1; if (!s.ok) { step.errors += 1; step.lastError = s.error; if (Array.isArray(s.path)) { step.lastPath = s.path.slice(0, 14).map((p) => String(p).slice(0, 160)); step.lastCookies = Array.isArray(s.cookies) ? s.cookies.slice(0, 14).map((c) => String(c).slice(0, 60)) : null; } }
      step.ms.push(ms);
      if (step.n % 5 === 0 || step.n < 20) Object.assign(step, summary(step.ms));
    }
    // Someone who stays signed in arrives once: signing in and loading every file for the first time is far slower
    // than what follows and says nothing about the load. It is shown per step, but does not decide the limit.
    // Where every visit is an arrival (people arriving fresh), it is exactly what is measured.
    const once = s.arrival && s.ok && r.config && r.config.sessionMode === 'keep' && r.kind !== 'build';
    const st = r.stages[r.stages.length - 1];
    if (once) { if (st && !st.closed) st.arrivals = (st.arrivals || 0) + 1; return; }
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
    if (r.probe) for (const s of r.probe.steps) Object.assign(s, summary(s.ms));
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
    if (r.kind === 'build' && r.verdict === 'passed' && r.scenario.type !== 'api' && (r.recorded || []).length && r.scenario.id) {
      // What the browser asked for, kept so that a load run can send it again without a browser.
      const rec = replay.finish(r.recorded, { steps: r.scenario.steps, user: r.users[0] && r.users[0].name, userId: r.users[0] && r.users[0].id, ssoId: r.ssoId });
      const visit = Math.max(5, Math.round(r.steps.reduce((a, s) => a + (s.avg || 0), 0) / 1000));
      rec.visitSeconds = visit;
      store.write(`recording-${r.scenario.id}.json`, rec);
      const all = store.scenarios();
      const mine = all.find((x) => x.id === r.scenario.id);
      if (mine) { mine.load = { ...mine.load, visitSeconds: visit }; store.saveScenarios(all); }
      this.log(`Recorded for lightweight users: ${rec.requests} requests in ${rec.steps.length} step${rec.steps.length === 1 ? '' : 's'} (${rec.data} of them are data requests a returning visitor sends again). One visit took about ${visit} s.`);
    }
    else if (r.kind === 'build' && r.verdict === 'passed' && r.scenario.type !== 'api' && r.scenario.id) this.log('Nothing was recorded for lightweight users: the worker that ran this test did not send a recording. A worker on another machine may be running an older version of the app - update it (Capacity and workers lists the workers).');
    if (!failed) r.answer = answer(r);
    if (r.answer && r.restarts) r.answer.facts.push(`A worker process of this app ended unexpectedly and was started again ${r.restarts} time${r.restarts > 1 ? 's' : ''} during the run. The users on it signed in again; the figures around those moments are less reliable.`);
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

module.exports = { Controller, normalize, validate, plan, summary, simplePlan, firstTrouble, answer, engineOf, recordingOf, cleanStored, janitor, records, limits, hostInfo, MAX_RUN_MS };
