'use strict';
const $ = (id) => document.getElementById(id);
const view = $('view');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms || 0)} ms`);
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`; };
const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Sign in first.'); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function toast(text, bad) {
  const t = $('toast'); t.textContent = text; t.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), bad ? 7000 : 3200);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

let me = null; let settings = {}; let tests = []; let status = { run: null, workers: [] }; let events = null; let ed = null;

// ---- sign-in -----------------------------------------------------------------
function showLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); if (events) { events.close(); events = null; } }
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await api('POST', '/api/login', { user: f.get('user'), password: f.get('password') }); $('loginErr').textContent = ''; e.target.reset(); boot(); } catch (err) { $('loginErr').textContent = err.message; }
});
$('logout').onclick = guard(async () => { await api('POST', '/api/logout'); showLogin(); });

async function boot() {
  me = await (await fetch('/api/me')).json();
  if (!me.signedIn) return showLogin();
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  $('defaultPw').classList.toggle('hidden', !me.defaultPassword);
  $('whoami').textContent = `${me.name} · ${me.role === 'admin' ? 'administrator' : 'tester'}`;
  document.querySelectorAll('nav a.admin').forEach((a) => a.classList.toggle('hidden', me.role !== 'admin'));
  [settings, tests, status] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/scenarios'), api('GET', '/api/status')]);
  sideLabel();
  if (!events) {
    events = new EventSource('/api/events');
    events.onmessage = (m) => { status = JSON.parse(m.data); live(); };
  }
  if (!location.hash) location.hash = '#/overview';
  route(); refreshBadge();
  return undefined;
}
const insts = () => settings.instances || [];
const instOf = (id) => insts().find((i) => i.id === id) || insts()[0] || null;
const hostName = (u) => String(u || '').replace(/^https?:\/\//, '');
function sideLabel() { const n = insts().length; $('sideInstance').textContent = !n ? 'no instance set' : n === 1 ? hostName(insts()[0].url) : `${n} ServiceNow instances`; }
const busy = () => !!status.run && !['done', 'failed'].includes(status.run.state);
async function refreshBadge() {
  try { const r = await api('GET', '/api/records'); const left = r.runs.filter((x) => x.state === 'left').length; $('recBadge').textContent = left; $('recBadge').classList.toggle('hidden', !left); } catch { /* signed out */ }
}

// ---- routing -------------------------------------------------------------------
const routes = {
  overview: pageOverview, tests: pageTests, run: pageRun, history: pageHistory,
  'sn/connection': pageConnection, 'sn/records': pageRecords, 'admin/capacity': pageCapacity, 'admin/people': pagePeople, account: pageAccount,
};
let current = '';
function route() {
  const h = location.hash.replace(/^#\//, '') || 'overview';
  let key = h; let arg = '';
  if (h.startsWith('tests/')) { key = 'test'; arg = h.slice(6); } else if (h.startsWith('history/')) { key = 'historyRun'; arg = h.slice(8); }
  current = key;
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === h || (key === 'test' && arg !== 'new' && a.dataset.r === 'tests') || (key === 'historyRun' && a.dataset.r === 'history')));
  pageRun.last = '';
  const fn = key === 'test' ? () => pageTest(arg) : key === 'historyRun' ? () => pageHistoryRun(arg) : routes[key] || pageOverview;
  Promise.resolve(fn()).catch((e) => { view.innerHTML = `<div class="card"><div class="banner bad">${esc(e.message)}</div></div>`; });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
function live() {
  $('liveDot').classList.toggle('hidden', !busy());
  if (current === 'run') pageRun();
  if (current === 'overview') pageOverview();
}
const head = (title, text, right = '') => `<div class="head"><div><h1>${esc(title)}</h1>${text ? `<p>${text}</p>` : ''}</div><div class="row">${right}</div></div>`;

// ---- overview --------------------------------------------------------------------
async function pageOverview() {
  const r = status.run;
  const runs = await api('GET', '/api/runs');
  const recs = await api('GET', '/api/records');
  const left = recs.runs.filter((x) => x.state === 'left');
  const lim = settings.limits || {};
  const h = [head('Overview', 'Measure how a ServiceNow page or API behaves as more people use it at the same time.', '<a class="btn primary" href="#/tests/new">New test</a>')];
  if (!insts().some((i) => i.hasPassword)) h.push(`<div class="card"><div class="banner info">Start here: ${me.role === 'admin' ? '<a href="#/sn/connection">add a ServiceNow instance and its credentials</a>' : 'ask an administrator to add a ServiceNow instance'}.</div></div>`);
  h.push(`<div class="tiles">
    <div class="tile"><b>${tests.length}</b><span>tests saved</span></div>
    <div class="tile"><b>${runs.length}</b><span>runs recorded</span></div>
    <div class="tile ${left.length ? 'bad' : ''}"><b>${left.length}</b><span>runs with records still on the instance</span></div>
    <div class="tile"><b>${lim.maxBrowsers || '-'}</b><span>browsers at once on this machine (${lim.cores} cores)</span></div></div>`);
  h.push(`<div class="card"><h2>Now</h2>${busy()
    ? `<p><span class="pill ${r.state}">${esc(r.state)}</span> &nbsp;<b>${esc(r.scenario.name)}</b> - ${esc(r.phase)}</p><a class="btn primary" href="#/run">Open the live run</a>`
    : '<p class="hint">No run is active.</p>'}</div>`);
  h.push(`<div class="card"><h2>Recent runs</h2>${runs.length ? runsTable(runs.slice(0, 6)) : '<div class="empty">Nothing has run yet. Create a test, press Test to check it, then run it.</div>'}</div>`);
  const html = h.join('');
  if (html !== pageOverview.last) { pageOverview.last = html; view.innerHTML = html; }
}
const KIND = { build: 'Test run', load: 'Load run' };
const PATTERN = { ramp: 'Find the limit', sustained: 'Sustained', parallel: 'Parallel' };
function runsTable(runs) {
  return `<table><tr><th>When</th><th>Test</th><th>Kind</th><th>State</th><th class="r">Users</th><th class="r">Steps</th><th class="r">Slowest 5%</th><th>Result</th></tr>
    ${runs.map((r) => {
    const p95 = Math.max(0, ...(r.steps || []).map((s) => s.p95 || 0));
    const t = r.totals || {};
    return `<tr class="click" data-go="#/history/${r.id}"><td>${fmtTime(r.createdAt)}<br><small class="muted">${esc(r.by || '')}</small></td><td><b>${esc(r.name || '')}</b><br><span class="tag">${r.type === 'api' ? 'API' : 'Browser'}</span> <small class="muted">${esc(r.instance || '')}</small></td>
      <td>${r.kind === 'build' ? 'Test run' : esc(PATTERN[r.pattern] || 'Load run')}</td><td><span class="pill ${r.state}">${esc(r.state)}</span></td><td class="r">${r.users || 0}</td><td class="r">${t.n || 0}${t.errors ? `<br><small style="color:var(--bad)">${t.errors} failed</small>` : ''}</td><td class="r">${p95 ? fmtMs(p95) : ''}</td>
      <td>${r.limit ? `Limit at ${r.limit.users} users` : ''}${r.cleanup && !r.cleanup.complete ? ' <span class="pill bad">cleanup pending</span>' : ''}</td></tr>`;
  }).join('')}</table>`;
}

// ---- tests ---------------------------------------------------------------------
async function pageTests() {
  tests = await api('GET', '/api/scenarios');
  view.innerHTML = head('Tests', 'A test is a list of steps, the users that perform them, and how the load is applied.', '<a class="btn primary" href="#/tests/new">New test</a>')
    + `<div class="card">${tests.length ? `<table><tr><th>Name</th><th>Instance</th><th>Type</th><th>Sign-in</th><th>Steps</th><th>Load</th><th>By</th><th></th></tr>
      ${tests.map((t) => `<tr class="click" data-go="#/tests/${t.id}"><td><b>${esc(t.name)}</b></td><td>${esc((instOf(t.instance) || {}).name || '')}</td><td><span class="tag">${t.type === 'api' ? 'API' : 'Browser'}</span></td><td>${esc(AUTH[t.authMode])}</td>
        <td>${t.steps.filter((s) => s.type !== 'wait').length}</td><td>${esc(loadText(t))}</td><td>${esc(t.createdBy || '')}</td><td class="r"><span class="link">Open</span></td></tr>`).join('')}</table>`
    : '<div class="empty">No tests yet.<br><br><a class="btn primary" href="#/tests/new">Create the first one</a></div>'}</div>`;
}
const AUTH = { sso: 'Mock SSO', local: 'User name and password', basic: 'Basic authentication', oauth: 'OAuth token' };
function loadText(t) {
  const l = t.load;
  if (l.pattern === 'sustained') return `${plural(l.users, 'user')} for ${fmtDur(l.durationSeconds)}`;
  if (l.pattern === 'parallel') return `${plural(l.users, 'user')} at the same moment, ${l.passes} time${l.passes === 1 ? '' : 's'} each`;
  return `${l.startUsers} to ${l.maxUsers} users, +${l.stepUsers} every ${fmtDur(l.stepSeconds)}`;
}
const blank = () => ({
  id: '', name: '', type: 'ui', instance: (insts()[0] || {}).id || '', proxy: '(connection)', authMode: 'sso', users: { prefix: 'lt.user.', roles: [], groups: [] },
  steps: [{ type: 'open', name: '', url: '' }],
  load: { pattern: 'ramp', users: 5, durationSeconds: 300, passes: 1, startUsers: 1, stepUsers: 1, stepSeconds: 60, maxUsers: 5, holdSeconds: 60, thinkSeconds: 3, sessionMode: 'keep', entry: 'home', usersPerWorker: 5, localWorkers: 'auto', timeoutSeconds: 60 },
  limit: { p95Ms: 8000, errorPct: 5, action: 'pause' },
});

async function pageTest(id) {
  if (id === 'new') ed = blank();
  else { tests = await api('GET', '/api/scenarios'); const t = tests.find((x) => x.id === id); if (!t) throw new Error('This test no longer exists.'); ed = JSON.parse(JSON.stringify(t)); ed.users.roles = ed.users.roles.join(', '); ed.users.groups = ed.users.groups.join(', '); }
  if (Array.isArray(ed.users.roles)) { ed.users.roles = ed.users.roles.join(', '); ed.users.groups = ed.users.groups.join(', '); }
  if (!insts().some((i) => i.id === ed.instance)) ed.instance = (insts()[0] || {}).id || '';
  drawEditor();
}
const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
const set = (o, k, v) => { const ps = k.split('.'); const last = ps.pop(); ps.reduce((a, p) => a[p], o)[last] = v; };
const inp = (k, label, { type = 'text', ph = '', hint = '', min = '', step = '' } = {}) => `<label>${label}<input data-k="${k}" type="${type}" placeholder="${esc(ph)}" value="${esc(get(ed, k))}" ${min !== '' ? `min="${min}"` : ''} ${step ? `step="${step}"` : ''}>${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;
const sel = (k, label, opts, hint = '') => `<label>${label}<select data-k="${k}">${opts.map(([v, t]) => `<option value="${v}" ${String(get(ed, k)) === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;
const choice = (k, v, title, text) => `<button type="button" class="choice ${get(ed, k) === v ? 'on' : ''}" data-choice="${k}" data-v="${v}"><b>${title}</b><span>${text}</span></button>`;

function drawEditor() {
  const api_ = ed.type === 'api';
  const lim = settings.limits || {};
  const cap = api_ ? lim.maxApiUsers : lim.maxBrowsers;
  const l = ed.load;
  const peak = l.pattern === 'ramp' ? +l.maxUsers : +l.users;
  const h = [head(ed.id ? ed.name || 'Test' : 'New test', 'Describe what a user does. Press Test to try it once with a single user before putting load on the instance.', '<a class="btn" href="#/tests">Back to tests</a>')];

  h.push(`<div class="card"><h2>1. What to test</h2><p class="hint">Give it a name and choose how ServiceNow is reached.</p>
    <div class="grid" style="margin-bottom:14px">${inp('name', 'Test name', { ph: 'Knowledge article from an email link' })}
      ${sel('instance', 'ServiceNow instance', insts().length ? insts().map((i) => [i.id, `${i.name} - ${hostName(i.url)}`]) : [['', 'No instance set up yet']], insts().length ? '' : 'An administrator adds instances under ServiceNow > Instances.')}
      ${sel('proxy', 'Reach it through', [['(connection)', `Same as the instance (${(instOf(ed.instance) || {}).proxy || 'direct'})`], ['direct', 'Direct, no proxy'], ...(settings.proxies || []).map((p) => [p.name, `Proxy: ${p.name}`])], (settings.proxies || []).length ? 'For addresses that cannot be reached straight from this machine.' : 'No proxy is defined yet. An administrator adds them under ServiceNow > Instances.')}</div>
    <div class="choices">
      ${choice('type', 'ui', 'Browser (UI)', 'Real browsers open pages, as people do. Shows what a person waits for. Heavy: a few dozen at once per machine.')}
      ${choice('type', 'api', 'API', 'Plain HTTP requests to a REST endpoint. Light: hundreds or thousands of users from one machine.')}
    </div></div>`);

  h.push(`<div class="card"><h2>2. Steps</h2><div class="target">Against <b>${esc((instOf(ed.instance) || {}).name || 'no instance')}</b> <code>${esc((instOf(ed.instance) || {}).url || '')}</code> - paths below are added to this address. <span class="hint">Change the instance in section 1.</span></div><p class="hint">${api_
    ? 'Requests each user sends, in order, again and again. A URL can be a path on the instance, for example <code>/api/now/table/incident?sysparm_limit=10</code>.'
    : 'What each user does, in order. A link can be a path on the instance, for example <code>/kb_view.do?sysparm_article=KB0012345</code>. A step is timed until the page has stopped loading.'}</p>
    <div id="steps">${stepsHtml()}</div>
    <div class="row" style="margin-top:12px">${api_
    ? '<button class="btn small" data-add="open">+ Request</button><button class="btn small" data-add="wait">+ Wait</button>'
    : '<button class="btn small" data-add="open">+ Open a link</button><button class="btn small" data-add="click">+ Click</button><button class="btn small" data-add="fill">+ Type text</button><button class="btn small" data-add="wait">+ Wait</button>'}</div></div>`);

  const authHelp = {
    sso: 'Creates a temporary identity provider record on ServiceNow that only these users are pointed at. Everyone else signs in as usual.',
    local: 'The temporary users get a random password and sign in through the login page. Works only where the instance allows local login.',
    basic: 'The temporary users are web-service-only accounts with a random password, sent as basic authentication.',
    oauth: 'Creates a temporary OAuth client on ServiceNow; each user asks for a token with it and sends the token with every request.',
  };
  h.push(`<div class="card"><h2>3. Test users</h2><p class="hint">Created on ServiceNow when a run starts, removed when it ends. A name that already exists stops the run before anything is created.</p>
    <div class="choices" style="margin-bottom:14px">${api_
    ? choice('authMode', 'basic', 'Basic authentication', 'User name and password with each request.') + choice('authMode', 'oauth', 'OAuth token', 'Password grant, then a bearer token.')
    : choice('authMode', 'sso', 'Mock SSO', 'Single sign-on through this app, for the test users only.') + choice('authMode', 'local', 'User name and password', 'The ServiceNow login page.')}</div>
    <p class="hint">${authHelp[ed.authMode] || ''}</p>
    <div class="grid">${inp('users.prefix', 'User name starts with', { ph: 'lt.user.', hint: ed.users.prefix ? `${esc(ed.users.prefix)}001, ${esc(ed.users.prefix)}002, ...` : '' })}
      ${inp('users.roles', 'Roles (comma separated)', { ph: 'itil' })}${inp('users.groups', 'Groups (comma separated)', { ph: 'Service Desk' })}</div></div>`);

  const pat = l.pattern;
  h.push(`<div class="card"><h2>4. Load</h2><p class="hint">How users are put on the instance.</p>
    <div class="choices" style="margin-bottom:14px">
      ${choice('load.pattern', 'ramp', 'Find the limit', 'Start small and add users step by step until pages get slow or fail.')}
      ${choice('load.pattern', 'sustained', 'Sustained load', 'A steady number of users for a set time. Shows whether the instance holds up.')}
      ${choice('load.pattern', 'parallel', 'Parallel load', 'Everyone starts in the same instant. Shows what a sudden rush does.')}
    </div>
    <div class="grid">${pat === 'ramp' ? inp('load.startUsers', 'Start with (users)', { type: 'number', min: 1 }) + inp('load.stepUsers', 'Add (users)', { type: 'number', min: 1 }) + inp('load.stepSeconds', 'Every (seconds)', { type: 'number', min: 5 }) + inp('load.maxUsers', 'Up to (users)', { type: 'number', min: 1 }) + inp('load.holdSeconds', 'Then hold for (seconds)', { type: 'number', min: 0 })
    : pat === 'sustained' ? inp('load.users', 'Users at the same time', { type: 'number', min: 1 }) + inp('load.durationSeconds', 'For (seconds)', { type: 'number', min: 10, hint: `${fmtDur(+l.durationSeconds || 0)}` })
      : inp('load.users', 'Users starting together', { type: 'number', min: 1 }) + inp('load.passes', 'Times each goes through the steps', { type: 'number', min: 1 })}
      ${inp('load.thinkSeconds', api_ ? 'Pause between requests (seconds)' : 'Time a user spends on a page (seconds)', { type: 'number', min: 0, step: '0.5' })}
      ${inp('load.timeoutSeconds', 'Give up on a step after (seconds)', { type: 'number', min: 5 })}
      ${api_ ? '' : sel('load.sessionMode', 'Session', [['keep', 'Sign in once and keep going'], ['relogin', 'Arrive fresh for every pass']])}
      ${api_ || ed.authMode !== 'sso' ? '' : sel('load.entry', 'Arrival', [['home', 'Sign in first, then the steps'], ['link', 'Click the first link with no session']], 'The second is someone clicking a link in an email.')}
    </div>
    <div class="banner ${peak > cap ? 'bad' : 'info'}" style="font-weight:400">${peak > cap
    ? `<b>${peak} ${api_ ? 'API users' : 'browsers'} is above the limit of ${cap}.</b> ${api_ ? '' : `This machine has ${lim.cores} cores; more browsers than that would measure the test machine, not ServiceNow.`} ${me.role === 'admin' ? 'Change it under <a href="#/admin/capacity">Capacity and workers</a>.' : ''}`
    : `Peak: <b>${plural(peak || 0, api_ ? 'API user' : 'browser')}</b> of ${cap} allowed on this machine. ${plural(peak || 0, 'temporary user')} will be created on ServiceNow and removed afterwards.`}</div></div>`);

  h.push(`<div class="card"><h2>5. When is it too slow?</h2><p class="hint">The run marks the first step of the load that crosses this line.</p>
    <div class="grid">${inp('limit.p95Ms', '95% of steps slower than (ms)', { type: 'number', min: 0 })}${inp('limit.errorPct', 'Or more failed steps than (%)', { type: 'number', min: 0, step: '0.5' })}
      ${sel('limit.action', 'Then', [['pause', 'Pause the run'], ['stop', 'Stop and clean up'], ['continue', 'Note it and continue']])}</div></div>`);

  h.push(`<div class="actionbar"><button class="btn" id="edSave">Save</button>
    <button class="btn" id="edTest" title="One temporary user goes through the steps once. Everything is removed afterwards.">Test (1 user, once)</button>
    <button class="btn primary" id="edRun">Run load test</button><span class="hint" id="edMsg"></span><span style="flex:1"></span>
    ${ed.id ? '<button class="btn danger" id="edDelete">Delete test</button>' : ''}</div>`);
  view.innerHTML = h.join('');
  $('edSave').onclick = guard(async () => { await saveTest(); toast('Saved.'); });
  $('edTest').onclick = guard(async () => { const t = await saveTest(); await api('POST', '/api/run', { scenarioId: t.id, kind: 'build' }); location.hash = '#/run'; });
  $('edRun').onclick = guard(async () => {
    const t = await saveTest(true);
    const n = t.load.pattern === 'ramp' ? t.load.maxUsers : t.load.users;
    if (!confirm(`Run "${t.name}"?\n\n${plural(n, 'temporary user')} will be created on ${(instOf(t.instance) || {}).url || 'the instance'} and removed when the run ends.`)) return;
    await api('POST', '/api/run', { scenarioId: t.id, kind: 'load' }); location.hash = '#/run';
  });
  if (ed.id) $('edDelete').onclick = guard(async () => { if (!confirm(`Delete the test "${ed.name}"? Its past runs stay in History.`)) return; await api('DELETE', `/api/scenarios/${ed.id}`); location.hash = '#/tests'; });
}
function stepsHtml() {
  const api_ = ed.type === 'api';
  const f = (i, k, ph, v) => `<input data-s="${i}" data-sk="${k}" placeholder="${esc(ph)}" value="${esc(v == null ? '' : v)}">`;
  const label = { open: api_ ? 'Request' : 'Open link', click: 'Click', fill: 'Type text', wait: 'Wait' };
  return ed.steps.map((s, i) => {
    const btns = `<span class="row"><button class="btn small" data-up="${i}" ${i ? '' : 'disabled'}>↑</button><button class="btn small" data-down="${i}" ${i < ed.steps.length - 1 ? '' : 'disabled'}>↓</button><button class="btn small danger" data-del="${i}">Remove</button></span>`;
    if (s.type === 'wait') return `<div class="step ${api_ ? 'api' : ''}"><span class="no">${i + 1}</span><b>Wait</b>${f(i, 'ms', 'Milliseconds', s.ms || 1000)}<span class="hint">milliseconds, not timed</span>${api_ ? '' : '<span></span>'}${btns}</div>`;
    if (api_) {
      return `<div class="step api"><span class="no">${i + 1}</span><select data-s="${i}" data-sk="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => `<option ${s.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select>${f(i, 'name', 'Name shown in results', s.name)}${f(i, 'url', '/api/now/table/incident?sysparm_limit=10', s.url)}${btns}
        ${['POST', 'PUT', 'PATCH'].includes(s.method) ? `<textarea data-s="${i}" data-sk="body" placeholder='JSON body, for example {"short_description":"load test"}'>${esc(s.body || '')}</textarea>` : ''}</div>`;
    }
    const mid = s.type === 'open' ? f(i, 'url', 'Link: full URL or /path on the instance', s.url) + f(i, 'waitSelector', 'Optional: done when this appears (text=Words or a CSS selector)', s.waitSelector)
      : s.type === 'click' ? f(i, 'selector', 'What to click (text=Label or a CSS selector)', s.selector) + f(i, 'waitSelector', 'Optional: done when this appears', s.waitSelector)
        : f(i, 'selector', 'Field (CSS selector)', s.selector) + f(i, 'value', 'Text to type', s.value);
    return `<div class="step"><span class="no">${i + 1}</span><b>${label[s.type]}</b>${f(i, 'name', 'Name shown in results', s.name)}${mid}${btns}</div>`;
  }).join('') || '<p class="hint">No steps yet.</p>';
}
view.addEventListener('input', (e) => {
  const d = e.target.dataset;
  if (d.k && ed) { set(ed, d.k, e.target.value); if (['load.maxUsers', 'load.users'].includes(d.k) && e.type === 'change') drawEditor(); }
  if (d.s !== undefined && ed) { ed.steps[+d.s][d.sk] = e.target.value; if (d.sk === 'method') $('steps').innerHTML = stepsHtml(); }
});
view.addEventListener('change', (e) => { const d = e.target.dataset; if (ed && d.k && ['load.maxUsers', 'load.users', 'users.prefix', 'load.durationSeconds', 'instance'].includes(d.k)) drawEditor(); });
async function saveTest(strict) {
  if (!String(ed.name || '').trim()) throw new Error('Give the test a name.');
  const out = await api('PUT', '/api/scenarios', ed);
  ed.id = out.scenario.id;
  if (location.hash !== `#/tests/${ed.id}`) history.replaceState(null, '', `#/tests/${ed.id}`);
  const local = out.problems.filter((p) => !/limit/.test(p) || strict);
  if (local.length) throw new Error(local.join(' '));
  tests = await api('GET', '/api/scenarios');
  return out.scenario;
}

// ---- the live run -----------------------------------------------------------------
function pageRun() {
  const r = status.run;
  const html = r ? runHtml(r, status.workers, true)
    : head('Live run', 'Nothing is running.') + '<div class="card"><div class="empty">Open a test and press <b>Test</b> or <b>Run load test</b>.<br><br><a class="btn primary" href="#/tests">Go to tests</a></div></div>';
  if (html === pageRun.last) return;
  pageRun.last = html;
  const log = view.querySelector('.log'); const top = log ? log.scrollTop : 0; const y = window.scrollY;
  view.innerHTML = html;
  if (top && view.querySelector('.log')) view.querySelector('.log').scrollTop = top;
  window.scrollTo(0, y);
  if (r) drawChart(view.querySelector('canvas'), r);
}
const PHASES = [['checking', 'Check'], ['provisioning', 'Create users'], ['starting', 'Start workers'], ['running', 'Run'], ['stopping', 'Clean up'], ['done', 'Done']];
function runHtml(r, workers, isLive) {
  const t = r.totals || { n: 0, errors: 0, serverErrors: 0, requests: 0 };
  const sc = r.scenario; const api_ = sc.type === 'api';
  const errPct = t.n ? ((100 * t.errors) / t.n).toFixed(1) : '0';
  const active = !['done', 'failed'].includes(r.state);
  const order = PHASES.map((p) => p[0]); const at = order.indexOf(r.state === 'paused' ? 'running' : r.state === 'failed' ? 'done' : r.state);
  const h = [];
  const ctl = isLive && active ? `<button class="btn" data-run="pause" ${r.state === 'running' && r.kind !== 'build' ? '' : 'disabled'}>Pause</button><button class="btn" data-run="resume" ${r.state === 'paused' ? '' : 'disabled'}>Resume</button><button class="btn danger" data-run="stop" ${r.state === 'stopping' ? 'disabled' : ''} title="Ends the load and removes everything the run created on the instance.">Stop and clean up</button>` : (isLive ? `<a class="btn" href="#/tests/${sc.id}">Open the test</a>` : '<a class="btn" href="#/history">Back to history</a>');
  h.push(head(`${r.kind === 'build' ? 'Test run' : PATTERN[sc.load.pattern]}: ${sc.name}`, `<span class="pill ${r.verdict === 'passed' ? 'good' : r.state}">${esc(r.verdict === 'passed' ? 'passed' : r.state)}</span> &nbsp;${esc(r.phase || '')}`, ctl));

  h.push(`<div class="card"><div class="steps-flow">${PHASES.map(([k, label], i) => `<span class="phase ${i < at || r.state === 'done' ? 'done' : i === at ? 'on' : ''}">${label}</span>`).join('')}</div>
    ${r.kind === 'load' && r.planSeconds ? `<div class="progress"><i style="width:${Math.min(100, (100 * r.elapsed) / r.planSeconds).toFixed(1)}%"></i></div><p class="hint" style="margin:6px 0 0">${fmtDur(r.elapsed)} of ${fmtDur(r.planSeconds)} planned</p>` : ''}
    <dl class="kv" style="margin-top:12px"><dt>Instance</dt><dd>${r.instance ? `<b>${esc(r.instance.name)}</b> <code>${esc(r.instance.url)}</code>${r.instance.proxy ? ` through proxy ${esc(r.instance.proxy)}` : ''}` : ''}</dd><dt>Type</dt><dd>${api_ ? 'API' : 'Browser'} · ${esc(AUTH[sc.authMode])}${r.kind === 'load' ? ` · ${esc(loadText(sc))}` : ''}</dd>
      <dt>Started</dt><dd>${fmtTime(r.createdAt)}${r.by ? ` by ${esc(r.by)}` : ''} · run ${esc(r.id)}</dd>
      <dt>On the instance</dt><dd>${r.cleanup ? (r.cleanup.complete ? `<span class="pill good">removed</span> ${r.cleanup.deleted} record(s) deleted, nothing left` : `<span class="pill bad">cleanup pending</span> ${(r.cleanup.remaining || []).length} record(s) may remain - retried automatically <button class="btn small" data-clean="${r.id}">Clean up now</button>`)
    : r.ledger ? `${plural(r.ledger, 'record')} created for this run · removed when it ends, and no later than ${new Date(r.removeBy).toLocaleTimeString([], { timeStyle: 'short' })}` : 'nothing created yet'}</dd></dl>
    ${r.kind === 'build' && r.verdict === 'passed' ? `<div class="banner ok">Passed: all ${(r.totals || {}).n || 0} step(s) succeeded with one user. The test is ready for load.</div>` : ''}
    ${r.error ? `<div class="banner bad">${r.kind === 'build' ? 'Failed. ' : ''}${esc(r.error)}</div>` : ''}
    ${r.limit ? `<div class="banner limit">Limit reached at ${r.limit.users} users: ${esc(r.limit.reason)}.<small>${r.limit.lastGood ? `The last step that stayed inside the limit was ${r.limit.lastGood} users.` : 'No earlier step stayed inside the limit.'}${r.limit.generatorBusy ? ' The load generator was at full CPU in that step, so this may be the test machine and not ServiceNow.' : ''}</small></div>`
    : r.kind === 'load' && r.state === 'done' && r.stages.length ? `<div class="banner ok">No limit reached up to ${Math.max(...r.stages.map((s) => s.users))} users at the same time.</div>` : ''}
    ${isLive && r.generatorBusy ? '<div class="banner limit">A worker machine is at 90% CPU or more: times measured now include the test machine being slow.</div>' : ''}</div>`);

  if (r.advice && r.advice.length) {
    h.push(`<div class="card"><h2>Why steps failed, and what to do</h2><p class="hint">Found by looking on the instance itself, right after the run.</p>${r.advice.map((a) => `<div class="advice"><b>${esc(a.title)}</b><p>${esc(a.detail)}</p>${a.evidence && a.evidence.length ? `<ul>${a.evidence.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>` : ''}</div>`).join('')}</div>`);
  }
  const warned = (r.checks || []).filter((c) => c.warn);
  if (warned.length && r.startedAt && r.state !== 'failed') h.push(`<div class="card"><div class="banner limit" style="margin:0">${warned.map((c) => `${esc(c.name)}: ${esc(c.detail)}`).join('<br>')}</div></div>`);
  if (r.checks && r.checks.length && (r.state === 'failed' || !r.startedAt)) {
    h.push(`<div class="card"><h2>Checks before anything is created</h2><ul class="checks">${r.checks.map((c) => `<li class="${c.warn ? 'warn' : c.ok ? 'ok' : 'no'}"><b>${esc(c.name)}</b> - ${esc(c.detail)}</li>`).join('')}</ul></div>`);
  }

  if (r.startedAt) {
    const sp = r.speed;
    h.push(`<div class="tiles">
      <div class="tile"><b>${r.active} / ${r.target}</b><span>users active / planned now</span></div>
      <div class="tile"><b>${sp ? sp.rate : 0}</b><span>steps finished per minute</span></div>
      <div class="tile"><b>${sp ? sp.reqs : 0}</b><span>${api_ ? 'requests' : 'browser requests'} per second</span></div>
      <div class="tile"><b>${sp && sp.avg ? fmtMs(sp.avg) : '-'}</b><span>average step, last 5 s</span></div>
      <div class="tile"><b>${sp && sp.p95 ? fmtMs(sp.p95) : '-'}</b><span>slowest 5%, last 5 s</span></div>
      <div class="tile ${t.errors ? 'bad' : ''}"><b>${t.errors}</b><span>failed of ${t.n} steps (${errPct}%)</span></div></div>`);
  }

  if (isLive && r.activity && r.activity.length) {
    const groups = {};
    for (const a of r.activity) groups[a.at] = (groups[a.at] || 0) + 1;
    const top = Object.entries(groups).sort((a, b) => b[1] - a[1]);
    const now = status.time || Date.now();
    h.push(`<div class="card"><h2>What the users are doing now</h2><p class="hint">${r.activity.length < r.active ? `The first ${r.activity.length} of ${r.active} users.` : `${plural(r.activity.length, 'user')}.`}</p>
      <div class="bars" style="margin-bottom:14px">${top.map(([k, n]) => `<div class="barrow"><span>${esc(k)}</span><div><i style="width:${(100 * n) / r.activity.length}%"></i></div><b class="num">${n}</b></div>`).join('')}</div>
      <div class="doing">${r.activity.map((a) => {
    const secs = Math.max(0, (now - a.since) / 1000);
    const cls = a.done ? 'done' : a.at === 'waiting' ? 'wait' : a.last && !a.last.ok ? 'bad' : secs > 10 ? 'slow' : '';
    return `<div class="vu ${cls}"><b>${esc(a.user)}</b><span>${esc(a.at)} · ${secs.toFixed(0)} s${a.last ? ` · last ${fmtMs(a.last.ms)}` : ''}</span></div>`;
  }).join('')}</div></div>`);
  }

  if (r.kind === 'load' && r.series && r.series.length) {
    h.push(`<div class="card"><h2>Response time and users over time</h2><canvas></canvas>
      <div class="legend"><span><i style="background:var(--accent)"></i>95% of steps faster than</span><span><i style="background:var(--chart2)"></i>users active</span><span><i style="background:var(--bad)"></i>failed steps</span><span><i style="background:var(--bad);height:1px"></i>your limit</span></div></div>`);
  }
  if (r.kind === 'load' && r.stages && r.stages.length > 1) {
    h.push(`<div class="card"><h2>By number of users</h2><table><tr><th>Users</th><th class="r">Steps</th><th class="r">Failed</th><th class="r">Average</th><th class="r">Half faster than</th><th class="r">95% faster than</th><th class="r">Slowest</th><th></th></tr>
      ${r.stages.map((s) => `<tr class="${s.breach ? 'bad' : ''}"><td><b>${s.users}</b></td><td class="r">${s.n}</td><td class="r">${s.errors}${s.n ? ` (${((100 * s.errors) / s.n).toFixed(1)}%)` : ''}</td><td class="r">${fmtMs(s.avg)}</td><td class="r">${fmtMs(s.p50)}</td><td class="r">${fmtMs(s.p95)}</td><td class="r">${fmtMs(s.max)}</td><td>${s.breach ? esc(s.breach) : (s.closed ? '' : 'in progress')}${s.busy ? ' · generator at full CPU' : ''}</td></tr>`).join('')}</table></div>`);
  }
  if (r.steps && r.steps.some((s) => s.n)) {
    h.push(`<div class="card"><h2>By step</h2><table><tr><th>Step</th><th class="r">Times</th><th class="r">Failed</th><th class="r">Average</th><th class="r">Half faster than</th><th class="r">95% faster than</th><th class="r">Slowest</th><th>Last error</th></tr>
      ${r.steps.map((s) => `<tr class="${s.errors ? 'bad' : ''}"><td>${s.index < 0 ? '' : `${s.index + 1}. `}<b>${esc(s.name)}</b></td><td class="r">${s.n}</td><td class="r">${s.errors}</td><td class="r">${fmtMs(s.avg)}</td><td class="r">${fmtMs(s.p50)}</td><td class="r">${fmtMs(s.p95)}</td><td class="r">${fmtMs(s.max)}</td><td>${esc(s.lastError || '')}</td></tr>`).join('')}</table></div>`);
  }
  if (r.shots && r.shots.length) {
    h.push(`<div class="card"><h2>${r.kind === 'build' ? 'What the user saw, step by step' : 'Screenshots of failed steps'}</h2><div class="shots">
      ${r.shots.map((s, i) => `<div class="shot ${s.ok ? '' : 'bad'}" data-shot="/api/runs/${r.id}/shots/${s.file}" data-cap="${esc(`${s.name} - ${fmtMs(s.ms)}${s.error ? ` - ${s.error}` : ''}`)}">
        <img loading="lazy" src="/api/runs/${r.id}/shots/${s.file}" alt="${esc(s.name)}">
        <div><b>${r.kind === 'build' ? `${i + 1}. ` : ''}${esc(s.name)}</b>${fmtMs(s.ms)} · ${esc(s.user || '')}${s.error ? `<br><span style="color:var(--bad)">${esc(s.error)}</span>` : ''}<br><span class="muted">${esc((s.url || '').slice(0, 90))}</span></div></div>`).join('')}</div></div>`);
  }
  if (r.trace && r.trace.length) {
    h.push(`<div class="card"><h2>${r.kind === 'build' ? 'What the API answered, step by step' : 'Failed requests'}</h2><table><tr><th>Step</th><th class="r">Status</th><th class="r">Time</th><th class="r">Size</th><th>Answer</th></tr>
      ${r.trace.slice(0, 40).map((x) => `<tr class="${x.ok ? '' : 'bad'}"><td><b>${esc(x.name)}</b><br><small class="muted">${esc(x.user || '')}</small></td><td class="r">${x.status || '-'}</td><td class="r">${fmtMs(x.ms)}</td><td class="r">${x.bytes ? `${(x.bytes / 1024).toFixed(1)} KB` : ''}</td><td>${x.error ? `<b>${esc(x.error)}</b><br>` : ''}<code>${esc((x.snippet || '').slice(0, 260))}</code></td></tr>`).join('')}</table></div>`);
  }
  if (isLive && workers && workers.length) {
    h.push(`<div class="card"><h2>Workers</h2><table><tr><th>Worker</th><th>Machine</th><th class="r">Users</th><th class="r">Capacity</th><th class="r">CPU</th><th class="r">Free memory</th></tr>
      ${workers.map((w) => `<tr class="${w.cpu >= 90 ? 'bad' : ''}"><td>${esc(w.name)}${w.local ? '' : ' <span class="tag">remote</span>'}</td><td>${esc(w.host || '')}</td><td class="r">${w.active}</td><td class="r">${w.capacity}</td><td class="r">${w.cpu || 0}%</td><td class="r">${w.freeMb ? `${(w.freeMb / 1024).toFixed(1)} GB` : ''}</td></tr>`).join('')}</table></div>`);
  }
  if (r.log && r.log.length) h.push(`<div class="card"><h2>Log</h2><div class="log">${r.log.slice().reverse().map((l) => `${new Date(l.t).toLocaleTimeString()}  ${esc(l.text)}`).join('<br>')}</div></div>`);
  return h.join('');
}
function drawChart(cv, r) {
  if (!cv || !r.series.length) return;
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth; const H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const L = 62; const R = 40; const T = 10; const B = 24;
  const all = r.series;
  const maxT = Math.max(all[all.length - 1].t, r.planSeconds || 0, 10);
  const maxMs = Math.max(...all.map((p) => p.p95), r.scenario.limit.p95Ms || 0, 100) * 1.1;
  const maxU = Math.max(...all.map((p) => p.users), r.target || 0, 1);
  const x = (t) => L + ((W - L - R) * t) / maxT;
  const yMs = (v) => H - B - ((H - T - B) * v) / maxMs;
  const yU = (v) => H - B - ((H - T - B) * v) / maxU;
  g.font = '11px "Segoe UI", system-ui'; g.strokeStyle = col('--line'); g.fillStyle = col('--muted'); g.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = T + ((H - T - B) * i) / 4;
    g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
    g.textAlign = 'right'; g.fillText(fmtMs((maxMs * (4 - i)) / 4), L - 6, y + 4);
    g.textAlign = 'left'; g.fillText(String(Math.round((maxU * (4 - i)) / 4)), W - R + 6, y + 4);
  }
  g.textAlign = 'center';
  for (let i = 0; i <= 5; i += 1) g.fillText(fmtDur((maxT * i) / 5), x((maxT * i) / 5), H - 6);
  if (r.scenario.limit.p95Ms) { g.setLineDash([5, 4]); g.strokeStyle = col('--bad'); g.beginPath(); g.moveTo(L, yMs(r.scenario.limit.p95Ms)); g.lineTo(W - R, yMs(r.scenario.limit.p95Ms)); g.stroke(); g.setLineDash([]); }
  const line = (key, y, color, stepped) => {
    // a stretch with no finished step has no response time: leave it out of that line
    const pts = stepped ? all : all.filter((p) => p.n > 0);
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
    pts.forEach((p, i) => { if (!i) g.moveTo(x(p.t), y(p[key])); else { if (stepped) g.lineTo(x(p.t), y(pts[i - 1][key])); g.lineTo(x(p.t), y(p[key])); } });
    g.stroke();
  };
  line('users', yU, col('--chart2'), true);
  line('p95', yMs, col('--accent'), false);
  g.fillStyle = col('--bad');
  all.forEach((p) => { if (p.errors) { g.beginPath(); g.arc(x(p.t), H - B - 4, Math.min(6, 2 + p.errors), 0, 7); g.fill(); } });
}
window.addEventListener('resize', () => { const cv = view.querySelector('canvas'); if (cv && current === 'run' && status.run) drawChart(cv, status.run); });

// ---- history ---------------------------------------------------------------------
async function pageHistory() {
  const runs = await api('GET', '/api/runs');
  view.innerHTML = head('History', 'Every run, with its results and screenshots.') + `<div class="card">${runs.length ? runsTable(runs) : '<div class="empty">No runs yet.</div>'}</div>`;
}
async function pageHistoryRun(id) {
  const r = await api('GET', `/api/runs/${id}`);
  view.innerHTML = runHtml(r, [], false) + `<div class="actionbar"><button class="btn danger" data-rmrun="${r.id}">Delete this run's results</button></div>`;
  drawChart(view.querySelector('canvas'), r);
}

// ---- ServiceNow: connection ---------------------------------------------------------
async function pageConnection() {
  settings = await api('GET', '/api/settings'); sideLabel();
  const pxOpts = (cur) => `<option value="">Direct, no proxy</option>${(settings.proxies || []).map((p) => `<option value="${esc(p.name)}" ${cur === p.name ? 'selected' : ''}>Proxy: ${esc(p.name)}</option>`).join('')}`;
  const card = (i) => `<div class="card inst" data-id="${esc(i.id || '')}"><div class="row" style="justify-content:space-between"><h2>${esc(i.name || 'New instance')}</h2>${i.id ? `<span class="pill ${i.hasPassword ? 'good' : 'warn'}">${i.hasPassword ? 'credentials saved' : 'no password yet'}</span>` : ''}</div>
      <div class="grid" style="margin-top:8px">
        <label>Name <input class="iN" value="${esc(i.name || '')}" placeholder="Test instance"></label>
        <label>Instance URL <input class="iU" value="${esc(i.url || '')}" placeholder="https://dev12345.service-now.com"></label>
        <label>Admin user <input class="iA" value="${esc(i.user || '')}" autocomplete="off"></label>
        <label>Password <input class="iP" type="password" autocomplete="new-password"><small class="muted">${i.hasPassword ? 'A password is saved. Leave empty to keep it.' : 'No password saved yet.'}</small></label>
        <label>Reach it through <select class="iX">${pxOpts(i.proxy)}</select></label></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-itest>Save and test the connection</button><span style="flex:1"></span><button class="btn small danger" data-irm>Remove this instance</button></div><div class="iMsg"></div></div>`;
  view.innerHTML = head('ServiceNow instances', 'The instances tests can run against, and the account this app uses on each to create and remove the temporary users. Each test chooses its instance.', '<button class="btn" id="iAdd">+ Instance</button><button class="btn primary" id="iSave">Save all</button>')
    + `<div id="iList">${insts().map(card).join('') || ''}</div>${insts().length ? '' : '<div class="card" id="iEmpty"><div class="empty">No instance yet. Add the first one.</div></div>'}
    <div class="card"><h2>Proxies</h2><p class="hint">For instances and addresses that cannot be reached straight from this machine. An instance and each test choose one by name.</p>
      <div id="pxList">${(settings.proxies || []).map((p) => `<div class="row" style="margin-bottom:8px"><input class="pxN" value="${esc(p.name)}" placeholder="Name" style="width:180px"><input class="pxU" value="${esc(p.url)}" placeholder="http://proxy.example.com:8080" style="flex:1;min-width:260px"><button class="btn small danger" data-rmpx>Remove</button></div>`).join('')}</div>
      <div class="row"><button class="btn small" id="pxAdd">+ Proxy</button><span class="hint">Address as <code>http://host:port</code>, or <code>http://user:password@host:port</code> when the proxy asks for a login. Save, then choose it on an instance.</span></div></div>
    <div class="card"><h2>What the account on each instance needs</h2><ul class="hint" style="margin:0;padding-left:18px">
      <li>The <b>admin</b> role: it creates users, role and group memberships, and for Mock SSO an identity provider record and its certificate; for OAuth tests a temporary OAuth client.</li>
      <li>REST with basic authentication. Where the instance restricts it, the role <code>snc_basic_auth_api_access</code>. Best is an integration account: Identity type Machine, "Web service access only" ticked, no authenticator, "Password needs reset" not ticked.</li>
      <li>Passwords are kept in this app's data folder on this machine and are never shown again.</li></ul></div>`;
  $('iAdd').onclick = () => { const e = $('iEmpty'); if (e) e.remove(); $('iList').insertAdjacentHTML('beforeend', card({})); };
  $('pxAdd').onclick = () => $('pxList').insertAdjacentHTML('beforeend', '<div class="row" style="margin-bottom:8px"><input class="pxN" placeholder="Name" style="width:180px"><input class="pxU" placeholder="http://proxy.example.com:8080" style="flex:1;min-width:260px"><button class="btn small danger" data-rmpx>Remove</button></div>');
  $('pxList').onclick = (e) => { if (e.target.dataset.rmpx !== undefined) e.target.parentElement.remove(); };
  const save = async () => {
    const proxies = [...document.querySelectorAll('#pxList .row')].map((row) => ({ name: row.querySelector('.pxN').value.trim(), url: row.querySelector('.pxU').value.trim() })).filter((p) => p.name || p.url);
    if (proxies.some((p) => !p.name || !p.url)) throw new Error('Each proxy needs a name and an address.');
    const cards = [...document.querySelectorAll('#iList .inst')];
    const instances = cards.map((c) => ({ id: c.dataset.id, name: c.querySelector('.iN').value.trim(), url: c.querySelector('.iU').value.trim(), user: c.querySelector('.iA').value.trim(), password: c.querySelector('.iP').value, proxy: c.querySelector('.iX').value }));
    if (instances.some((i) => !/^https?:\/\/[^/\s]+\/?$/i.test(i.url))) throw new Error('Each instance needs its address, for example https://dev12345.service-now.com');
    const names = instances.map((i) => i.url.replace(/\/+$/, ''));
    settings = await api('PUT', '/api/settings', { instances, proxies });
    if (settings.proxies.length !== proxies.length) toast('A proxy address was not understood and was left out.', true);
    sideLabel();
    return names;
  };
  $('iSave').onclick = guard(async () => { await save(); toast('Saved.'); pageConnection(); });
  $('iList').onclick = guard(async (e) => {
    const c = e.target.closest('.inst'); if (!c) return;
    if (e.target.dataset.irm !== undefined) { if (confirm('Remove this instance from the app? Tests that use it will need another one chosen.')) { c.remove(); await save(); toast('Removed.'); pageConnection(); } return; }
    if (e.target.dataset.itest === undefined) return;
    const at = [...document.querySelectorAll('#iList .inst')].indexOf(c);
    await save();
    const inst = insts()[at];
    await pageConnection();
    const msg = document.querySelectorAll('#iList .inst')[at].querySelector('.iMsg');
    msg.innerHTML = '<div class="banner info">Testing...</div>';
    const t = await api('POST', '/api/settings/test', { instanceId: inst.id });
    msg.innerHTML = !t.ok ? `<div class="banner bad">${esc(t.error)}${(t.hints || []).length ? `<small>${t.hints.map(esc).join('<br>')}</small>` : ''}</div>`
      : `<div class="banner ${t.admin ? 'ok' : 'limit'}">Connected as ${esc(t.user)}${t.admin ? ' (admin)' : ' - this user does not have the admin role'}.<small>${t.build ? `Build ${esc(t.build)}. ` : ''}Multi-Provider SSO is ${t.multiSso ? 'on: Mock SSO tests can run.' : 'off: Mock SSO tests need it on. This app does not change it.'}</small></div>`;
  });
}

// ---- ServiceNow: records on the instance ------------------------------------------
const TABLE = { sys_user: 'user', saml2_update1_properties: 'identity provider record', sys_certificate: 'certificate', idp_certificate: 'certificate link', oauth_entity: 'OAuth client' };
async function pageRecords() {
  const d = await api('GET', '/api/records');
  const rows = d.runs.filter((r) => r.total);
  const left = rows.filter((r) => r.state === 'left');
  view.innerHTML = head('Records on the instance', `Everything this app has created on ServiceNow, run by run. A run removes its records when it ends; anything still there is removed automatically, and never stays longer than ${d.autoCleanMinutes / 60} hours.`,
    `<button class="btn ${left.length ? 'primary' : ''}" id="recClean" ${left.length ? '' : 'disabled'}>Clean up everything left</button>`)
    + `<div class="tiles"><div class="tile ${left.length ? 'bad' : ''}"><b>${left.length}</b><span>runs with records still on the instance</span></div>
      <div class="tile"><b>${rows.filter((r) => r.state === 'in use').length}</b><span>in use by the active run</span></div>
      <div class="tile"><b>${rows.filter((r) => r.state === 'removed').reduce((a, r) => a + r.total, 0)}</b><span>records created and removed so far</span></div></div>
    <div class="card">${rows.length ? `<table><tr><th>Run</th><th>Instance</th><th>Created on ServiceNow</th><th>State</th><th>Removed</th><th></th></tr>
      ${rows.map((r) => `<tr><td><b>${esc(r.name || '')}</b><br><small class="muted">${r.kind === 'build' ? 'Test run' : 'Load run'} · ${fmtTime(r.createdAt)}${r.by ? ` · ${esc(r.by)}` : ''}</small></td><td>${esc(r.instance || '')}</td>
        <td>${Object.entries(r.byTable).map(([t, n]) => plural(n, TABLE[t] || t)).join(', ')}</td>
        <td>${r.state === 'removed' ? '<span class="pill good">removed</span>' : r.state === 'in use' ? '<span class="pill busy">in use</span>' : `<span class="pill bad">still there</span>${r.error ? `<br><small style="color:var(--bad)">${esc(r.error)}</small>` : ''}`}</td>
        <td>${r.state === 'removed' ? fmtTime(r.removedAt) : `<span class="muted">by ${fmtTime(r.removeBy)} at the latest</span>`}</td>
        <td class="r">${r.state === 'left' ? `<button class="btn small" data-clean="${r.id}">Clean up now</button>` : `<a href="#/history/${r.id}">Open run</a>`}</td></tr>`).join('')}</table>`
    : '<div class="empty">Nothing has been created on the instance yet.</div>'}</div>`;
  $('recClean').onclick = guard(async () => { $('recClean').disabled = true; $('recClean').textContent = 'Cleaning up...'; await api('POST', '/api/records/clean'); toast('Cleanup finished.'); pageRecords(); refreshBadge(); });
}

// ---- administration ----------------------------------------------------------------
async function pageCapacity() {
  settings = await api('GET', '/api/settings');
  const lim = settings.limits;
  view.innerHTML = head('Capacity and workers', 'How much load this machine may generate. A browser test past the machine\'s own limit measures the test machine, not ServiceNow.')
    + `<div class="card"><h2>This machine</h2><dl class="kv"><dt>Host</dt><dd>${esc(lim.host)}</dd><dt>Size</dt><dd>${lim.cores} CPU cores · ${lim.memGb} GB memory</dd>
      <dt>Suggested</dt><dd><b>${lim.suggestedBrowsers}</b> browsers at once (about 2.5 per core, 0.4 GB each)</dd><dt>In force</dt><dd><b>${lim.maxBrowsers}</b> browsers at once · <b>${lim.maxApiUsers}</b> API users at once</dd></dl>
      <h3>Limits</h3><div class="grid">
        <label>Most browsers at once <input id="cpB" type="number" min="0" value="${settings.maxBrowsers || ''}" placeholder="${lim.suggestedBrowsers} (from the machine's size)"><small class="muted">Empty = worked out from the machine's size. Raise it when workers on other machines are connected.</small></label>
        <label>Most API users at once <input id="cpA" type="number" min="0" value="${settings.maxApiUsers || ''}" placeholder="2000"></label></div>
      <h3>Browser</h3><div class="grid">
        <label>Browser <select id="cpBr">${[['chromium', 'Playwright\'s own Chromium'], ['chrome', 'Google Chrome (installed)'], ['msedge', 'Microsoft Edge (installed)']].map(([v, t]) => `<option value="${v}" ${settings.browser === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Window <select id="cpH"><option value="true" ${settings.headless !== false ? 'selected' : ''}>Hidden (headless)</option><option value="false" ${settings.headless === false ? 'selected' : ''}>Visible</option></select></label>
        <label>Address of this app as the workers' browsers see it <input id="cpI" placeholder="http://127.0.0.1:8787" value="${esc(settings.idpBaseUrl)}"><small class="muted">Only for workers on other machines: the Mock SSO pages are served from here.</small></label></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="cpSave">Save</button></div></div>
    <div class="card"><h2>Workers on other machines</h2><p class="hint">Copy the project to another machine, run <code>npm ci</code>, then:</p><pre>node src/worker.js --controller ${esc(settings.idpBaseUrl || location.origin)} --token ${esc(settings.workerToken)} --capacity 10</pre>
      ${status.workers.length ? `<h3>Connected now</h3><table><tr><th>Worker</th><th>Machine</th><th class="r">Capacity</th><th class="r">CPU</th></tr>${status.workers.map((w) => `<tr><td>${esc(w.name)}</td><td>${esc(w.host || '')}</td><td class="r">${w.capacity}</td><td class="r">${w.cpu || 0}%</td></tr>`).join('')}</table>` : '<p class="hint">No worker is connected right now. Local workers are started for each run.</p>'}</div>`;
  $('cpSave').onclick = guard(async () => { settings = await api('PUT', '/api/settings', { maxBrowsers: +$('cpB').value || 0, maxApiUsers: +$('cpA').value || 0, browser: $('cpBr').value, headless: $('cpH').value === 'true', idpBaseUrl: $('cpI').value.trim().replace(/\/+$/, '') }); toast('Saved.'); pageCapacity(); });
}
async function pagePeople() {
  const users = await api('GET', '/api/users');
  view.innerHTML = head('People', 'Who can sign in. Testers create and run tests; administrators also hold the ServiceNow connection, the limits and this list.')
    + `<div class="card"><table><tr><th>User name</th><th>Role</th><th></th></tr>${users.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.name === me.name ? ' <span class="tag">you</span>' : ''}${u.defaultPassword ? ' <span class="pill bad">default password</span>' : ''}</td><td>${u.role === 'admin' ? 'Administrator' : 'Tester'}</td><td class="r">${u.name === me.name ? '' : `<button class="btn small danger" data-rmuser="${esc(u.name)}">Remove</button>`}</td></tr>`).join('')}</table></div>
    <div class="card"><h2>Add a person</h2><div class="grid"><label>User name <input id="puN" autocomplete="off"></label><label>Password (8+ characters) <input id="puP" type="password" autocomplete="new-password"></label>
      <label>Role <select id="puR"><option value="tester">Tester</option><option value="admin">Administrator</option></select></label></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="puAdd">Add</button></div></div>`;
  $('puAdd').onclick = guard(async () => { await api('POST', '/api/users', { name: $('puN').value, password: $('puP').value, role: $('puR').value }); toast('Added.'); pagePeople(); });
}
function pageAccount() {
  view.innerHTML = head('My account', `Signed in as ${esc(me.name)} (${me.role === 'admin' ? 'administrator' : 'tester'}).`)
    + `<div class="card"><h2>Change password</h2><div class="grid"><label>New password (8+ characters) <input id="acP" type="password" autocomplete="new-password"></label></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="acSave">Change password</button></div><p class="hint">You will be asked to sign in again.</p></div>`;
  $('acSave').onclick = guard(async () => { await api('POST', '/api/password', { password: $('acP').value }); toast('Password changed. Sign in again.'); setTimeout(showLogin, 900); });
}

// ---- clicks that work on every page -----------------------------------------------
document.body.addEventListener('click', guard(async (e) => {
  const t = e.target;
  // A click lands on whatever is under the pointer - the title or the text INSIDE a button - so look for the
  // nearest element that carries an action, not only at the element that was hit.
  const actor = (t.closest && t.closest('[data-choice],[data-add],[data-del],[data-up],[data-down]')) || t;
  const d = actor.dataset || {};
  const shot = t.closest && t.closest('.shot');
  const go = t.closest && t.closest('[data-go]');
  if (shot) { $('lightbox').querySelector('img').src = shot.dataset.shot; $('lightbox').querySelector('p').textContent = shot.dataset.cap; $('lightbox').classList.remove('hidden'); return; }
  if (t.closest && t.closest('#lightbox')) { $('lightbox').classList.add('hidden'); return; }
  if (d.choice) { set(ed, d.choice, d.v); if (d.choice === 'type') { ed.authMode = d.v === 'api' ? 'basic' : 'sso'; ed.steps = ed.steps.filter((s) => ['open', 'wait'].includes(s.type) || d.v === 'ui'); ed.load.usersPerWorker = d.v === 'api' ? 100 : 5; } drawEditor(); return; }
  if (d.add) { ed.steps.push(d.add === 'wait' ? { type: 'wait', ms: 2000 } : { type: d.add, name: '', url: '', selector: '', method: 'GET' }); $('steps').innerHTML = stepsHtml(); return; }
  if (d.del !== undefined || d.up !== undefined || d.down !== undefined) {
    const st = ed.steps;
    if (d.del !== undefined) st.splice(+d.del, 1); else if (d.up !== undefined) st.splice(+d.up - 1, 0, st.splice(+d.up, 1)[0]); else st.splice(+d.down + 1, 0, st.splice(+d.down, 1)[0]);
    $('steps').innerHTML = stepsHtml(); return;
  }
  if (d.run) { await api('POST', `/api/run/${d.run}`); return; }
  if (d.clean) { t.disabled = true; t.textContent = 'Cleaning up...'; const out = await api('POST', `/api/runs/${d.clean}/cleanup`); toast(out.complete ? 'Removed from the instance.' : 'Some records could not be removed yet.', !out.complete); status = await api('GET', '/api/status'); refreshBadge(); route(); return; }
  if (d.rmrun) { if (confirm('Delete this run\'s results and screenshots from this app?')) { await api('DELETE', `/api/runs/${d.rmrun}`); location.hash = '#/history'; } return; }
  if (d.rmuser) { if (confirm(`Remove ${d.rmuser}?`)) { await api('DELETE', `/api/users/${d.rmuser}`); pagePeople(); } return; }
  if (go && !t.closest('button')) location.hash = go.dataset.go;
}));

boot();
