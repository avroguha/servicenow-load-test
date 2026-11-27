'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.UILOAD_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'uiload-test-'));
const { normalize, validate, plan, summary, Controller, records, MAX_RUN_MS } = require('../src/run');
const store = require('../src/store');
const { quiet } = require('../src/worker');
const root = path.join(__dirname, '..');

test('a scenario is normalised to safe numbers', () => {
  const sc = normalize({ name: ' x ', users: { prefix: 'lt.', roles: 'itil, admin' }, steps: [{ type: 'open', url: '/a' }, null, {}], load: { maxUsers: '4', startUsers: 9, stepSeconds: 1 }, limit: { action: 'explode' } });
  assert.strictEqual(sc.load.maxUsers, 4); assert.strictEqual(sc.load.startUsers, 4); assert.strictEqual(sc.load.stepSeconds, 5);
  assert.deepStrictEqual(sc.users.roles, ['itil', 'admin']); assert.strictEqual(sc.steps.length, 1); assert.strictEqual(sc.limit.action, 'pause');
  assert.deepStrictEqual(validate(sc), []);
  assert.ok(validate(normalize({ users: { prefix: '!' }, steps: [{ type: 'click' }] })).length >= 2);
});

test('percentiles', () => {
  const s = summary(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepStrictEqual(s, { n: 100, avg: 51, p50: 51, p95: 96, max: 100 });
  assert.strictEqual(summary([]).n, 0);
});

test('a stage over the limit sets the limit once and names the last good stage', () => {
  const c = new Controller({ port: 0 });
  clearInterval(c.timer);
  const r = { id: 't', scenario: normalize({ users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/' }], limit: { p95Ms: 1000, errorPct: 5, action: 'pause' } }), stages: [], log: [], state: 'running', limit: null, users: [], totals: {}, steps: [], series: [], shots: [], ledger: [] };
  c.run = r; c.persist = () => {};
  const stage = (users, ms, errors = 0) => { const st = { users, ms, n: ms.length, errors, to: 0, busy: users === 3 }; r.stages.push(st); c.closeStage(r, st); return st; };
  assert.ok(!stage(1, [200, 300, 250, 220, 210, 205]).breach);
  assert.ok(!stage(2, [5000, 6000]).breach, 'too few samples to judge');
  assert.match(stage(3, [900, 950, 2000, 2100, 2500, 3000]).breach, /95% of steps/);
  assert.deepStrictEqual({ users: r.limit.users, lastGood: r.limit.lastGood, busy: r.limit.generatorBusy }, { users: 3, lastGood: 2, busy: true });
  assert.strictEqual(r.state, 'paused');
  assert.match(stage(4, [100, 100, 100, 100, 100, 100], 3).breach, /failed/);
  assert.strictEqual(r.limit.users, 3, 'the first limit stays');
});

test('the page-quiet wait ends when requests stop, and gives up at the deadline naming what is open', async () => {
  const w = { inflight: new Map(), lastChange: Date.now() };
  assert.strictEqual(await quiet(w, 60, Date.now() + 1000), w.lastChange);
  w.inflight.set({ url: () => 'https://x.example/api/slow?x=1' }, 0); w.lastChange = Date.now();
  await assert.rejects(quiet(w, 60, Date.now() + 200), /1 request\(s\) open: \/api\/slow/);
  const s = { inflight: new Map([[{ url: () => 'https://x/stream' }, Date.now() - 5000]]), lastChange: Date.now() - 100 };
  await quiet(s, 50, Date.now() + 500);          // answered long ago: a stream, not waited for
});

test('supply chain: versions are exact and every one has passed the 72-hour gate', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const [name, v] of Object.entries(pkg.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version`);
  const { readLock, judge } = require('../scripts/check-release-age');
  const times = JSON.parse(fs.readFileSync(path.join(root, 'deps-publish-times.json'), 'utf8'));
  const v = judge(readLock(root), times);
  assert.deepStrictEqual([v.unknown, v.tooYoung], [[], []]);
});

test('the data folder (it holds the admin password) is never committed or served', () => {
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\/data\/$/m);
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.match(server, /path\.basename\(url\.pathname\)/, 'static files are served by base name from public/ only');
  assert.ok(!/password: s\.password/.test(server), 'the saved password is never sent to the page');
});

test('the three load patterns become a plan the clock can follow', () => {
  const base = { users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/' }] };
  assert.deepStrictEqual(plan(normalize({ ...base, load: { pattern: 'ramp', startUsers: 2, stepUsers: 3, stepSeconds: 30, maxUsers: 11, holdSeconds: 60 } })), { start: 2, step: 3, stepSeconds: 30, max: 11, seconds: 150, passes: 0 });
  const steady = plan(normalize({ ...base, load: { pattern: 'sustained', users: 20, durationSeconds: 600 } }));
  assert.deepStrictEqual([steady.start, steady.max, steady.seconds, steady.passes], [20, 20, 600, 0]);
  const burst = plan(normalize({ ...base, load: { pattern: 'parallel', users: 50, passes: 2 } }));
  assert.deepStrictEqual([burst.start, burst.max, burst.passes], [50, 50, 2]);
});

test('a test above the machine\'s limit is refused, browser and API separately', () => {
  const lim = { maxBrowsers: 10, maxApiUsers: 500 };
  const ui = normalize({ type: 'ui', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/' }], load: { pattern: 'sustained', users: 11 } });
  // Told to use real browsers: more than the machine can drive is refused, and the way out is named.
  assert.match(validate({ ...ui, load: { ...ui.load, engine: 'browser' } }, lim).join(' '), /above this machine's limit of 10[\s\S]*lightweight users/);
  // Left to choose: more than the machine's browsers means lightweight users, which need a recording first.
  assert.match(validate(ui, lim).join(' '), /runs with lightweight users[\s\S]*Press "Test \(1 user, once\)" first/);
  assert.match(validate({ ...ui, authMode: 'local' }, lim).join(' '), /Mock SSO only/);
  assert.deepStrictEqual(validate({ ...ui, load: { ...ui.load, users: 10 } }, lim), []);
  const apiTest = normalize({ type: 'api', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/api/now/table/incident', method: 'post', body: '{"a":1}' }], load: { pattern: 'parallel', users: 400 } });
  assert.strictEqual(apiTest.authMode, 'basic'); assert.strictEqual(apiTest.steps[0].method, 'POST');
  assert.deepStrictEqual(validate(apiTest, lim), []);
  assert.match(validate(normalize({ ...apiTest, steps: [{ type: 'click', selector: 'x' }, { type: 'open', url: '/a', body: '{bad' }] }), lim).join(' '), /requests and waits only.*not valid JSON/);
});

test('nothing a run created may outlive two hours, and the records page knows what is where', () => {
  assert.strictEqual(MAX_RUN_MS, 2 * 3600 * 1000);
  const src = fs.readFileSync(path.join(root, 'src', 'run.js'), 'utf8');
  assert.match(src, /now - r\.createdAt > MAX_RUN_MS\) \{ this\.stop\(/, 'the clock stops a run at the limit');
  assert.match(fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8'), /setInterval\(sweep, 5 \* 60000\)/, 'leftovers are cleaned without anyone asking');
  const now = Date.now();
  store.saveRun('r-gone', { id: 'r-gone', kind: 'load', state: 'done', createdAt: now, scenario: { name: 'A' }, ledgerRows: [{ table: 'sys_user', id: '1' }, { table: 'sys_user', id: '2' }], cleanup: { complete: true, at: now } });
  store.saveRun('r-left', { id: 'r-left', kind: 'load', state: 'failed', createdAt: now, scenario: { name: 'B' }, ledgerRows: [{ table: 'oauth_entity', id: '3' }], cleanup: { complete: false, remaining: [{}], failed: [{ error: 'HTTP 403' }] } });
  store.saveRun('r-none', { id: 'r-none', kind: 'build', state: 'failed', createdAt: now, scenario: { name: 'C' }, ledgerRows: [] });
  const by = Object.fromEntries(records(null).map((r) => [r.id, r]));
  assert.deepStrictEqual([by['r-gone'].state, by['r-left'].state, by['r-none'].state], ['removed', 'left', 'nothing']);
  assert.deepStrictEqual(by['r-gone'].byTable, { sys_user: 2 });
  assert.strictEqual(by['r-left'].removeBy, now + MAX_RUN_MS); assert.strictEqual(by['r-left'].error, 'HTTP 403');
});

test('several instances: the old single connection becomes the first, passwords are kept, a test names its own', () => {
  store.write('settings.json', { instanceUrl: 'https://one.example.com/', user: 'svc', password: 'p1', connectionProxy: '' });
  let s = store.settings();
  assert.deepStrictEqual(s.instances.map((i) => [i.id, i.url, i.user, i.password]), [['default', 'https://one.example.com', 'svc', 'p1']]);
  s = store.saveSettings({ proxies: [{ name: 'office', url: 'proxy.avro.com:8080' }], instances: [{ id: 'default', name: 'One', url: 'https://one.example.com', user: 'svc', password: '', proxy: 'office' }, { name: 'Two', url: 'https://two.example.com/', user: 'svc2', password: 'p2', proxy: 'gone' }, { name: 'bad', url: 'not a url' }] });
  assert.strictEqual(s.instances.length, 2, 'an address that is not one is left out');
  assert.strictEqual(s.instances[0].password, 'p1', 'an empty password keeps the saved one');
  assert.strictEqual(s.instances[0].proxy, 'office'); assert.strictEqual(s.instances[1].proxy, '', 'a proxy that does not exist is not kept');
  const two = s.instances[1];
  assert.strictEqual(store.instance(s, two.id).url, 'https://two.example.com');
  assert.strictEqual(store.instance(s, '').id, 'default', 'no name means the first');
  assert.throws(() => store.instance(s, 'removed'), /no longer configured/);
  const { SN } = require('../src/sn');
  const sn = SN.fromSettings(s, two.id);
  assert.deepStrictEqual([sn.base, sn.userName, sn.proxy, sn.instance.name], ['https://two.example.com', 'svc2', '', 'Two']);
  assert.strictEqual(SN.fromSettings(s, 'default').proxy, 'http://proxy.avro.com:8080');
  assert.strictEqual(normalize({ instance: two.id, users: { prefix: 'lt.' }, steps: [] }).instance, two.id);
  store.write('settings.json', {});
  assert.throws(() => store.instance(store.settings(), ''), /No ServiceNow instance is set up yet/);
});

// ---- a run must never sit silent, and must always end with a verdict --------
function liveRun(over = {}) {
  const c = new Controller({ port: 0 });
  clearInterval(c.timer);
  const sc = normalize({ name: 'T', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/' }] });
  const r = { id: 'run1', kind: 'build', scenario: sc, state: 'running', phase: '', createdAt: Date.now(), startedAt: Date.now(), log: [], ledger: [], users: [{ name: 'lt.001' }], stages: [], steps: [{ index: 0, name: 'open /', n: 0, errors: 0, ms: [] }], series: [], shots: [], trace: [], advice: [], totals: { n: 0, errors: 0, serverErrors: 0, requests: 0 }, finished: new Set(), target: 1, active: 0, elapsed: 0, plan: plan(sc), ...over };
  c.run = r; c.persist = () => {};
  c.sn = { query: async () => [] };
  c.clean = async (run) => { run.cleanup = { complete: true, deleted: 0, failed: [], remaining: [] }; };
  return { c, r };
}
const settle = () => new Promise((s) => setTimeout(s, 50));

test('a worker that cannot start a browser ends the run at once, with its reason on the page', async () => {
  const { c, r } = liveRun();
  // The worker has no run of its own yet - it never got that far - but names the run it was given.
  c.workerSync({ name: 'local-1', local: true, capacity: 5, runId: 'run1', fatal: 'No browser could be started on this worker. Google Chrome did not start: executable not found', sys: {}, active: 0 });
  await settle();
  for (let i = 0; i < 400 && r.state !== 'failed'; i += 1) await settle();
  assert.strictEqual(r.state, 'failed');
  assert.match(r.error, /No browser could be started[\s\S]*Capacity and workers/);
  assert.ok(r.log.some((l) => /Google Chrome did not start/.test(l.text)), 'the reason is in the log');
});

test('what a worker says before it has started anything still reaches the log', () => {
  const { c, r } = liveRun();
  c.workerSync({ name: 'local-1', local: true, capacity: 5, runId: 'run1', log: ["Using Playwright's own Chromium. Google Chrome did not start: not installed"], sys: {}, active: 0 });
  assert.ok(r.log.some((l) => /Using Playwright's own Chromium/.test(l.text)));
  assert.match(fs.readFileSync(path.join(root, 'src', 'worker.js'), 'utf8'), /runId: \(current && current\.runId\) \|\| desired\.runId/, 'a worker names the run it was told to join, not only one it has started');
});

test('the verdict: no step ran is a failure; a test with a failed step fails; a clean test passes', async () => {
  let { c, r } = liveRun();
  await c.finish('The test run was given up');
  assert.deepStrictEqual([r.state, r.verdict], ['failed', 'failed']);
  assert.match(r.error, /No step ran at all/); assert.match(r.phase, /The test FAILED/);

  ({ c, r } = liveRun());
  c.sample(r, { step: 0, ok: false, ms: 900, error: 'HTTP 500' });
  await c.finish('The test run finished');
  assert.strictEqual(r.state, 'failed'); assert.match(r.error, /did not pass: 1 of 1 step failed/);

  ({ c, r } = liveRun());
  c.sample(r, { step: 0, ok: true, ms: 900 });
  await c.finish('The test run finished');
  assert.deepStrictEqual([r.state, r.verdict, r.error || ''], ['done', 'passed', '']);
  assert.match(r.phase, /The test PASSED: 1 step, none failed/);
});

test('a one-user test gives up after its steps\' time limits, not after ten minutes; a stuck user is named while it is stuck', async () => {
  const { c, r } = liveRun();
  r.lastTick = Date.now(); r.elapsed = 2 * (60 + 20) + 61;          // (1 step + sign-in) x (limit + 20 s) + 60 s
  c.workers.set('local-1', { name: 'local-1', lastSeen: Date.now(), sys: {}, active: 1, capacity: 5, activity: [{ id: 0, user: 'lt.001', at: 'opening a browser window', since: Date.now() - 200000 }] });
  r.elapsed = 10; await c.tick();
  assert.ok(r.log.some((l) => /lt\.001 has been on "opening a browser window" for \d+ s/.test(l.text)));
  r.lastTick = Date.now(); r.elapsed = 2 * 80 + 61; await c.tick();
  for (let i = 0; i < 400 && r.state !== 'failed'; i += 1) await settle();
  assert.strictEqual(r.state, 'failed'); assert.match(r.error, /did not finish within 4 minutes/);
});

// ---- a failed single sign-on is explained from what the app saw itself ------
test('"request id is empty" is about ServiceNow building its request, and the answer shows the browser\'s path and cookies', async () => {
  const { diagnose } = require('../src/diagnose');
  const sn = { query: async (table) => (table === 'syslog' ? [{ message: 'SAML2Error: Failed generating request id: request id is empty' }] : []) };
  const base = { createdAt: Date.now(), scenario: normalize({ name: 'T', authMode: 'sso', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/kb' }] }), shots: [], trace: [] };
  let out = await diagnose(sn, { ...base, idpStats: { issued: 0, refused: 0 }, steps: [{ errors: 1, lastError: 'not signed in (landed on /login_with_sso.do)', lastPath: ['200 https://x.example/kb_view.do'], lastCookies: ['glide_user_route'] }] });
  assert.strictEqual(out[0].title, 'ServiceNow could not start the single sign-on');
  assert.match(out[0].detail, /no JSESSIONID cookie/);
  assert.ok(!/session cookie between the two redirects/.test(out[0].detail), 'the old, wrong explanation');
  assert.ok(out[0].evidence.some((e) => /The browser was sent: 200 https:\/\/x\.example\/kb_view\.do/.test(e)));
  assert.ok(out[0].evidence.some((e) => /answered 0 sign-in request/.test(e)));
  // The identity provider did answer: the same log line is then probably somebody else's.
  out = await diagnose(sn, { ...base, idpStats: { issued: 1, refused: 0 }, steps: [{ errors: 1, lastError: 'not signed in', lastPath: [], lastCookies: [] }] });
  assert.match(out[0].detail, /may belong to another visitor/);
});

test('a failed step carries the browser\'s path and cookie names to the run', () => {
  const { c, r } = liveRun();
  c.sample(r, { step: 0, ok: false, ms: 5, error: 'x', path: ['302 https://a/b'], cookies: ['JSESSIONID'] });
  assert.deepStrictEqual([r.steps[0].lastPath, r.steps[0].lastCookies], [['302 https://a/b'], ['JSESSIONID']]);
  assert.match(fs.readFileSync(path.join(root, 'src', 'worker.js'), 'utf8'), /isNavigationRequest\(\) && q\.frame\(\) === page\.mainFrame\(\)/);
});

// ---- an instance that already has single sign-on --------------------------
test('a test browser arriving through a link is taken to the test identity provider, never to the company sign-on page', () => {
  const w = fs.readFileSync(path.join(root, 'src', 'worker.js'), 'utf8');
  const fn = w.slice(w.indexOf('async arriveBySso('), w.indexOf('async pause('));
  assert.ok(fn.length > 500, 'arriveBySso is missing');
  // Any top-level navigation leaving the instance (other than to this app) is answered with a redirect to the run's own provider.
  assert.match(fn, /route\.fulfill\(\{ status: 302, headers: \{ location: sso \}/);
  assert.match(fn, /login_with_sso\.do\?glide_sso_id=\$\{cfg\.ssoId\}/);
  assert.match(fn, /o !== cfg\.origin && o !== idpOrigin/);
  // A link that starts no sign-in at all (a guest page) is handled too, and the link is opened again if ServiceNow did not keep it.
  assert.match(fn, /if \(!visited && home\(\)\)/);
  assert.match(fn, /if \(!there\(\) && home\(\)\) r = await page\.goto\(target/);
  // Watching navigations switches the cache off, so it is always removed again.
  assert.match(fn, /page\.unroute\(match, divert\)/); assert.match(fn, /finally \{[\s\S]*await unwatch\(\)/);
  // Every sign-in is watched - a returning browser's and "Sign in first" too. ServiceNow has been seen to honour
  // the run's provider on a browser's first visit and choose its own on the next. The company page is never opened.
  assert.match(fn, /const guard = true;/);
  assert.match(fn, /route\.abort\('blockedbyclient'\)/);
  assert.ok(!/return route\.continue\(\);\s*\n\s*diverted \+= 1;[\s\S]*diverted >= 2/.test(fn));
  assert.match(fn, /clearCookies\(\{ domain: new URL\(cfg\.origin\)\.hostname \}\)/, 'a retry starts on a new connection');
  assert.match(w, /if \(cfg\.authMode === 'sso'\) return this\.arriveBySso\(null, deadline\)/);
  assert.match(w, /if \(viaLink && cfg\.authMode === 'sso'\) status = await this\.arriveBySso\(url, deadline\)/);
});

test('a click on the text inside a card or button still selects it', () => {
  // The choice cards hold a title and a line of text; a person clicks those, not the card's edge.
  const ui = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(ui, /t\.closest\('\[data-choice\],\[data-add\],\[data-del\],\[data-up\],\[data-down\]'\)/);
  assert.match(ui, /const d = actor\.dataset/);
});

// ---- a worker on another machine --------------------------------------------
test('a worker says in words why it cannot reach the controller', () => {
  const { whyNot } = require('../src/worker');
  assert.match(whyNot(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })), /does not trust the controller's certificate[\s\S]*--ca <file>[\s\S]*--insecure/);
  assert.match(whyNot(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })), /nothing answers at/);
  assert.match(whyNot(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), /firewall[\s\S]*HTTPS port/);
  const w = fs.readFileSync(path.join(root, 'src', 'worker.js'), 'utf8');
  assert.match(w, /sync\.failures === 1 \|\| sync\.failures % 30 === 0\) console\.error/, 'a failed connection is reported at once, not swallowed');
  assert.match(w, /rejectUnauthorized: !INSECURE/);
  assert.ok(!/fetch\(`\$\{CONTROLLER\}/.test(w), 'the controller is reached through talk(), which knows --ca and --insecure');
});

test('the sign-in pages are answered on the worker\'s own machine, so the record on the instance is the same for every worker', () => {
  const { relayWanted } = require('../src/worker');   // this process: controller http://127.0.0.1:8787, not a local worker
  const sso = { type: 'ui', authMode: 'sso' };
  assert.strictEqual(relayWanted({ ...sso, idpBaseUrl: 'http://127.0.0.1:8787' }), 0, 'the app itself answers on its own port');
  assert.strictEqual(relayWanted({ ...sso, idpBaseUrl: 'http://127.0.0.1:8790' }), 8790, 'another port needs the relay');
  assert.strictEqual(relayWanted({ ...sso, idpBaseUrl: 'https://loadtest.example' }), 0, 'a public address is reached by the browsers directly');
  assert.strictEqual(relayWanted({ type: 'ui', authMode: 'local', idpBaseUrl: 'http://127.0.0.1:8790' }), 0);
  assert.strictEqual(relayWanted({ type: 'api', authMode: 'sso', idpBaseUrl: 'http://127.0.0.1:8790' }), 0);
  const w = fs.readFileSync(path.join(root, 'src', 'worker.js'), 'utf8');
  assert.match(w, /srv\.listen\(port, '127\.0\.0\.1'/, 'the relay listens on loopback only');
  assert.match(w, /if \(!req\.url\.startsWith\('\/idp\/'\)\)/, 'and passes on nothing but the sign-in pages');
});
