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
  assert.match(validate(ui, lim).join(' '), /above this machine's limit of 10/);
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
