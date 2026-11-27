'use strict';
// Lightweight users: what is recorded from a browser, how it is made each user's
// own, and how the three simple questions become a load plan and an answer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const replay = require('../src/replay');
const { normalize, simplePlan, firstTrouble, answer, engineOf } = require('../src/run');

const O = 'https://x.example';

test('a recording keeps the instance\'s own requests and nothing that must not be kept', () => {
  const k = (o) => replay.keep({ method: 'GET', resourceType: 'xhr', headers: {}, status: 200, ...o }, O);
  assert.deepStrictEqual(k({ url: `${O}/api/now/sp/page?id=kb` }), { m: 'GET', u: '/api/now/sp/page?id=kb', t: 'data', s: 200 });
  assert.strictEqual(k({ url: `${O}/scripts/app.jsx?v=1`, resourceType: 'script' }).t, 'static');
  assert.strictEqual(k({ url: `${O}/esc?id=x`, resourceType: 'document' }).t, 'doc');
  assert.strictEqual(k({ url: 'https://other.example/a.js' }), null, 'another site');
  assert.strictEqual(k({ url: `blob:${O}/ee23a9c5-b5f5` }), null, 'a browser\'s own blob address is not a request to the instance');
  assert.strictEqual(k({ url: `${O}/amb/meta/connect` }), null, 'a long-lived channel');
  assert.strictEqual(k({ url: `${O}/x.do`, method: 'POST', postData: 'a'.repeat(40000) }), null, 'a very large body');
  const withToken = k({ url: `${O}/xmlhttp.do`, method: 'POST', postData: 'sysparm_ck=abc', headers: { 'x-usertoken': 'abc', 'content-type': 'application/x-www-form-urlencoded' } });
  assert.deepStrictEqual([withToken.k, withToken.ct, withToken.b], [1, 'application/x-www-form-urlencoded', 'sysparm_ck=abc']);
  // The stored recording never holds a token in a header field: only where the page itself put it, to be swapped later.
  const rec = replay.finish([{ index: 0, name: 'KB', ms: 900, requests: [{ ...withToken, token: 'abc' }] }], { steps: [{ type: 'open', url: '/esc' }], user: 'lt.001', userId: 'U1', ssoId: 'S1' });
  assert.deepStrictEqual(rec.was, { token: 'abc', user: 'lt.001', userId: 'U1', ssoId: 'S1' });
  assert.ok(!('token' in rec.steps[0].requests[0]));
  assert.strictEqual(rec.key, replay.stepsKey([{ type: 'open', url: '/esc' }]));
  assert.notStrictEqual(rec.key, replay.stepsKey([{ type: 'open', url: '/other' }]), 'a changed step makes the recording stale');
});

test('a recorded request becomes each user\'s own: token, name, record id and this run\'s identity provider', () => {
  const was = { token: 'OLDTOKEN', user: 'lt.001', userId: 'OLDID', ssoId: 'OLDSSO' };
  const p = replay.prepare({ m: 'POST', u: '/api/now/live/profiles/sys_user.OLDID?glide_sso_id=OLDSSO', t: 'data', s: 200, k: 1, ct: 'application/json', b: '{"ck":"OLDTOKEN","who":"lt.001"}' }, { origin: O, token: 'NEW', was, user: 'lt.007', userId: 'NEWID', ssoId: 'NEWSSO' });
  assert.strictEqual(p.url, `${O}/api/now/live/profiles/sys_user.NEWID?glide_sso_id=NEWSSO`);
  assert.strictEqual(p.body, '{"ck":"NEW","who":"lt.007"}');
  assert.strictEqual(p.headers['X-UserToken'], 'NEW');
  assert.ok(!JSON.stringify(p).includes('OLD'));
});

test('a returning visitor does not fetch the page\'s files again; an answer the browser also got is not a failure', () => {
  const rec = { steps: [{ index: 0, requests: [{ m: 'GET', u: '/a.js', t: 'static', s: 200 }, { m: 'GET', u: '/api/x', t: 'data', s: 200 }] }] };
  assert.strictEqual(replay.pick(rec, 0, { cold: true }).length, 2);
  assert.deepStrictEqual(replay.pick(rec, 0, { cold: false }).map((r) => r.u), ['/api/x']);
  assert.strictEqual(replay.failed(200, 200), '');
  assert.strictEqual(replay.failed(404, 404), '', 'the browser got the same 404');
  assert.match(replay.failed(404, 200), /HTTP 404 \(the browser got 200\)/);
  assert.match(replay.failed(503, 200), /HTTP 503/);
  assert.match(replay.failed(401, 200), /HTTP 401/);
  assert.strictEqual(replay.failed(0, 200), 'no answer');
});

test('the sign-in is followed without a browser: where ServiceNow sends it, the answer form, the page token', () => {
  const idp = 'http://127.0.0.1:8787/idp/sso?SAMLRequest=abc%2B&RelayState=r1';
  assert.strictEqual(replay.providerUrl(`/auth_redirect.do?sysparm_stack=no&sysparm_url=${encodeURIComponent(idp)}`, `${O}/login_with_sso.do`), idp);
  assert.strictEqual(replay.providerUrl('/navpage.do', `${O}/x`), '');
  const form = replay.parseForm('<form method="post" action="https://x.example/navpage.do"><input type="hidden" name="SAMLResponse" value="PHNhbWw&#x2b;"><input type="hidden" name="RelayState" value="a&amp;b"></form>');
  assert.deepStrictEqual(form, { action: 'https://x.example/navpage.do', fields: { SAMLResponse: 'PHNhbWw+', RelayState: 'a&b' } });
  assert.strictEqual(replay.findToken("var g_ck = '0123456789abcdef0123456789abcdef';"), '0123456789abcdef0123456789abcdef');
  assert.ok(replay.isLoginPage(`${O}/login.do`, ''));
  assert.ok(replay.isLoginPage(`${O}/esc`, '<input name="user_password">'));
  assert.ok(!replay.isLoginPage(`${O}/esc?id=kb`, '<html>article</html>'));
  const jar = new replay.Jar();
  jar.take(['JSESSIONID=abc; Path=/; Secure; HttpOnly', 'glide_user_route=n1; Path=/', 'gone=; Max-Age=0']);
  assert.strictEqual(jar.header(), 'JSESSIONID=abc; glide_user_route=n1');
  // The worker asks this app's identity provider itself and never opens another one.
  const w = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');
  assert.match(w, /if \(p\.origin !== idpOrigin\) \{ why = `ServiceNow chose its own sign-on page/);
  assert.match(w, /talk\('GET', p\.pathname \+ p\.search, \{ Cookie: `uiload_idp=\$\{this\.spec\.ticket\}` \}/);
});

test('the three questions become a plan: steady load, everyone at once, how many at once', () => {
  assert.deepStrictEqual(simplePlan({ question: 'sustain', users: 200, minutes: 30 }), { pattern: 'sustained', users: 200, durationSeconds: 1800, sessionMode: 'keep', action: 'continue' });
  // 60,000 people in 30 minutes, one visit 30 s: 1000 are there at the same moment.
  const surge = simplePlan({ question: 'surge', people: 60000, minutes: 30, visitSeconds: 30 });
  assert.deepStrictEqual([surge.pattern, surge.maxUsers, surge.startUsers, surge.stepUsers, surge.sessionMode, surge.action], ['ramp', 1000, 200, 200, 'relogin', 'stop']);
  const par = simplePlan({ question: 'parallel', users: 500, visitSeconds: 20 });
  assert.deepStrictEqual([par.pattern, par.startUsers, par.stepUsers, par.maxUsers, par.stepSeconds], ['ramp', 50, 50, 500, 40]);
  // The saved test carries the worked-out pattern, so the rest of the app needs to know nothing about questions.
  const sc = normalize({ type: 'ui', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/esc' }], load: { mode: 'simple', question: 'surge', qPeople: 60000, qMinutes: 30, visitSeconds: 30 } });
  assert.deepStrictEqual([sc.load.pattern, sc.load.maxUsers, sc.load.sessionMode, sc.limit.action], ['ramp', 1000, 'relogin', 'stop']);
  // 1000 at once is more than any machine's browsers: lightweight users; told to use browsers, browsers.
  assert.strictEqual(engineOf(sc, { maxBrowsers: 30, maxApiUsers: 2000 }), 'http');
  assert.strictEqual(engineOf(normalize({ ...sc, load: { ...sc.load, engine: 'browser' } }), { maxBrowsers: 30, maxApiUsers: 2000 }), 'ui');
  assert.strictEqual(engineOf(normalize({ ...sc, load: { mode: 'simple', question: 'sustain', qUsers: 10 } }), { maxBrowsers: 30, maxApiUsers: 2000 }), 'ui');
});

test('the answer is in words, against the question asked, and names when trouble began', () => {
  const limit = { p95Ms: 8000, errorPct: 5 };
  const ok = { t: 0, users: 50, n: 20, errors: 0, p95: 3000 };
  // One slow moment is not trouble; two in a row is, from the first of them on.
  assert.strictEqual(firstTrouble([ok, { ...ok, t: 10, p95: 9000 }, { ...ok, t: 20 }], limit), null);
  assert.deepStrictEqual(firstTrouble([ok, { ...ok, t: 10, p95: 9000 }, { ...ok, t: 20, p95: 12000 }], limit), { t: 20, users: 50, why: '95% of steps took up to 12.0 s' });
  assert.match(firstTrouble([{ ...ok, errors: 4 }, { ...ok, t: 10, errors: 6 }], limit).why, /30% of steps failed/);

  const base = (load, over) => ({ kind: 'load', engine: 'http', scenario: normalize({ type: 'ui', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/esc' }], load: { mode: 'simple', ...load } }), totals: { n: 400, errors: 0 }, steps: [{ ms: [1000, 2000, 3000] }], stages: [{ users: 200 }], series: [ok], elapsed: 1800, limit: null, ...over });
  let a = answer(base({ question: 'sustain', qUsers: 200, qMinutes: 30 }));
  assert.ok(a.ok); assert.match(a.headline, /^Yes\. 200 people at the same time were carried for 30 minutes/);
  assert.ok(a.facts.some((f) => /lightweight users/.test(f)) && a.facts.some((f) => /time a browser needs to draw the page comes on top/.test(f)));
  a = answer(base({ question: 'sustain', qUsers: 200, qMinutes: 30 }, { series: [ok, { ...ok, t: 600, p95: 9000 }, { ...ok, t: 610, p95: 9500 }] }));
  assert.ok(!a.ok); assert.match(a.headline, /^No\.[\s\S]*trouble began after 10 minutes/);
  a = answer(base({ question: 'surge', qPeople: 60000, qMinutes: 30, visitSeconds: 30 }, { stages: [{ users: 600 }], limit: { users: 600, lastGood: 400, reason: '12% of steps failed (limit 5%)' } }));
  assert.match(a.headline, /^No\. The instance coped with about 24,000 of the 60,000 people arriving within 30 minutes \(400 at the same moment\)\. At 600/);
  a = answer(base({ question: 'surge', qPeople: 60000, qMinutes: 30, visitSeconds: 30 }, { stages: [{ users: 1000 }] }));
  assert.match(a.headline, /^Yes\. 60,000 people arriving within 30 minutes were carried: that is 1000 at the same moment/);
  a = answer(base({ question: 'parallel', qUsers: 500 }, { stages: [{ users: 300 }], limit: { users: 300, lastGood: 250, reason: 'x', generatorBusy: true } }));
  assert.match(a.headline, /^About 250 people at the same moment\. At 300 trouble began[\s\S]*may be the test machine and not ServiceNow/);
  a = answer(base({ question: 'parallel', qUsers: 500 }, { stages: [{ users: 500 }] }));
  assert.match(a.headline, /^At least 500 people at the same moment/);
  assert.strictEqual(answer(base({ question: 'sustain' }, { totals: { n: 0, errors: 0 } })), null, 'a run in which nothing ran has no answer');
});

// ---- real browsers measuring beside a lightweight run -------------------------
test('measuring browsers are extra users whose times are kept apart from the load\'s numbers', () => {
  const { Controller } = require('../src/run');
  const mk = (load) => normalize({ type: 'ui', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/esc' }], load });
  assert.strictEqual(mk({}).load.probes, 2, 'two by default');
  assert.strictEqual(mk({ probes: 0 }).load.probes, 0);
  assert.strictEqual(mk({ probes: 99 }).load.probes, 5, 'never more than five');
  assert.strictEqual(normalize({ type: 'api', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/api/x' }], load: { probes: 3 } }).load.probes, 0, 'an API test has no page to look at');

  const c = new Controller({ port: 0 });
  clearInterval(c.timer);
  const r = { kind: 'load', light: 3, probes: 2, config: { sessionMode: 'relogin' }, totals: { n: 0, errors: 0, serverErrors: 0, requests: 0 }, stages: [{ users: 3, n: 0, errors: 0, ms: [] }], bucket: { ms: [], errors: 0, reqs: 0, browserMs: [], browserErrors: 0 },
    steps: [{ index: 0, name: 'KB', n: 0, errors: 0, ms: [] }], probe: { n: 0, errors: 0, steps: [{ index: 0, name: 'KB', n: 0, errors: 0, ms: [], lastError: '' }] } };
  c.sample(r, { vu: 1, step: 0, ok: true, ms: 900, requests: 20 });                       // a lightweight user
  c.sample(r, { vu: 3, step: 0, ok: true, ms: 6000, requests: 90 });                      // the first measuring browser
  c.sample(r, { vu: 4, step: 0, ok: false, ms: 60000, error: 'the page says: Not Authorized' });
  assert.deepStrictEqual(r.totals, { n: 1, errors: 0, serverErrors: 0, requests: 20 }, 'the load\'s totals count lightweight users only');
  assert.deepStrictEqual([r.stages[0].n, r.stages[0].ms, r.stages[0].browserMs], [1, [900], [6000]], 'a browser\'s time never decides the limit');
  assert.deepStrictEqual([r.probe.n, r.probe.errors, r.probe.steps[0].ms, r.probe.steps[0].lastError], [2, 1, [6000], 'the page says: Not Authorized']);
  assert.deepStrictEqual([r.bucket.ms, r.bucket.browserMs, r.bucket.browserErrors], [[900], [6000], 1]);

  // They run from the first second to the last, whatever the level, and on a worker of this machine when there is one.
  const run = fs.readFileSync(path.join(__dirname, '..', 'src', 'run.js'), 'utf8');
  assert.match(run, /filter\(\(i\) => i < r\.target \|\| \(i >= light && i < r\.users\.length\)\)/);
  assert.match(run, /const home = ws\.find\(\(x\) => x\.w\.local\) \|\| ws\[0\];/);
  const w = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');
  assert.match(w, /iterations >= cfg\.iterations && this\.spec\.kind !== 'browser'\) break;/, 'a measuring browser does not stop after its passes');
  assert.match(w, /No browser could be started for measuring alongside[\s\S]{0,200}continue;/, 'without a browser the run goes on, and says so');
});

test('the answer says what a person would have seen, with few people on and with the most', () => {
  const sc = normalize({ type: 'ui', users: { prefix: 'lt.' }, steps: [{ type: 'open', url: '/esc' }], load: { mode: 'simple', question: 'parallel', qUsers: 500 } });
  const base = { kind: 'load', engine: 'http', probes: 2, scenario: sc, totals: { n: 400, errors: 0 }, steps: [{ ms: [1000, 2000] }], series: [], elapsed: 600, limit: null };
  let a = answer({ ...base, probe: { n: 40, errors: 0 }, stages: [{ users: 50, browser: { n: 10, p50: 4000, p95: 5000 } }, { users: 500, browser: { n: 12, p50: 9000, p95: 14000 } }] });
  assert.ok(a.facts.some((f) => /measured by 2 real browsers during the run: a step took typically 4\.0 s with 50 people on, and 9\.0 s with 500 \(95% within 14\.0 s\)/.test(f)));
  a = answer({ ...base, probe: { n: 9, errors: 9 }, stages: [{ users: 50 }] });
  assert.ok(a.facts.some((f) => /finished no step successfully \(9 failed\)/.test(f)));
  a = answer({ ...base, probes: 0, probe: null, stages: [{ users: 50 }] });
  assert.ok(a.facts.some((f) => /The time a browser needs to draw the page comes on top/.test(f)));
});

test('a worker process that dies during a load run is started again, and its last words are kept', () => {
  const run = fs.readFileSync(path.join(__dirname, '..', 'src', 'run.js'), 'utf8');
  assert.match(run, /^const fs = require\('node:fs'\);$/m);
  // Its error output goes to a file, not a pipe: the last words of a process that dies abruptly are lost in a pipe.
  assert.match(run, /stdio: \['ignore', 'ignore', fd\]/);
  assert.match(run, /worker-\$\{name\}\.log/);
  assert.match(run, /if \(r\.kind !== 'build' && r\.restarts <= 3 && !r\.stopAsked\) \{[\s\S]{0,400}startOne\(name\);/, 'started again, three times at most, never for a one-user test');
  assert.match(run, /was started again \$\{r\.restarts\} time/, 'and the answer says that it happened');
});
