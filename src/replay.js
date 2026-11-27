'use strict';
// Lightweight users: the requests a real browser made, sent again without a browser.
//
// A browser costs a good part of a CPU core; the same requests sent as plain
// HTTP cost almost nothing, and ServiceNow cannot tell the difference - it
// answers the same requests either way. So a test is first run once in a real
// browser, which RECORDS what each step asked the instance for, and a load run
// can then REPLAY that for thousands of users, each with its own session.
//
// What a replay does not measure is the browser itself: drawing the page and
// running its scripts. It measures how long ServiceNow takes to answer.
const crypto = require('node:crypto');

const LONG_LIVED = /\/amb\/|\/amb_session|heartbeat|\/api\/now\/ui\/presence/i;
// Files a browser keeps: fetched by a new visitor, not again by a returning one.
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);
const STATIC_EXT = /\.(js|jsx|css|png|gif|jpe?g|svg|ico|woff2?|ttf|eot|map)(\?|$)/i;
const MAX_BODY = 32 * 1024;
const MAX_PER_STEP = 400;

// The steps a recording belongs to: a changed step makes the recording stale.
function stepsKey(steps) {
  const plain = (steps || []).map((s) => [s.type, s.url || '', s.selector || '', s.value || '', s.waitSelector || '']);
  return crypto.createHash('sha256').update(JSON.stringify(plain)).digest('hex').slice(0, 16);
}

// One request as it is kept in a recording, or null when it is not worth keeping.
function keep({ method, url, resourceType, postData, headers, status }, origin) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.origin !== origin) return null;   // other sites, and the browser's own blob: and data: addresses, are not what is being tested
  if (LONG_LIVED.test(u.pathname) || ['websocket', 'eventsource'].includes(resourceType)) return null;
  if (/^\/(idp|login_with_sso|auth_redirect|navpage)\b/.test(u.pathname) && method === 'GET' && /SAMLRequest|glide_sso_id/.test(u.search)) return null;   // the sign-in is done live, per user
  const h = headers || {};
  const out = { m: method, u: u.pathname + u.search, t: STATIC_TYPES.has(resourceType) || STATIC_EXT.test(u.pathname) ? 'static' : resourceType === 'document' ? 'doc' : 'data', s: status || 0 };
  if (h['content-type']) out.ct = String(h['content-type']).slice(0, 120);
  if (h.accept && out.t === 'data') out.a = String(h.accept).slice(0, 120);
  if (h['x-usertoken']) out.k = 1;                             // sent with the user's token
  if (h['x-requested-with']) out.x = String(h['x-requested-with']).slice(0, 40);
  if (postData != null && method !== 'GET') { if (Buffer.byteLength(postData) > MAX_BODY) return null; out.b = String(postData); }
  return out;
}

// The requests of one step for one visit. A returning visitor has the static files already.
function pick(recording, stepIndex, { cold }) {
  const st = (recording.steps || []).find((s) => s.index === stepIndex);
  if (!st) return [];
  return st.requests.filter((r) => cold || r.t !== 'static');
}

// A recorded request made into this user's own: its token, its name, this run's identity provider.
function prepare(req, { origin, token, was, user, userId, ssoId }) {
  const swap = (text) => {
    let t = String(text);
    if (was.token && token) t = t.split(was.token).join(token);
    if (was.user && user) t = t.split(was.user).join(user);
    if (was.userId && userId) t = t.split(was.userId).join(userId);
    if (was.ssoId && ssoId) t = t.split(was.ssoId).join(ssoId);
    return t;
  };
  const headers = { Accept: req.a || (req.t === 'doc' ? 'text/html,application/xhtml+xml,*/*;q=0.8' : '*/*') };
  if (req.ct) headers['Content-Type'] = req.ct;
  if (req.k && token) headers['X-UserToken'] = token;
  if (req.x) headers['X-Requested-With'] = req.x;
  return { method: req.m, url: origin + swap(req.u), headers, body: req.b == null ? undefined : swap(req.b), kind: req.t, recorded: req.s };
}

// Was this answer a failure? An answer the browser also got (a 404 for a missing icon) is not one.
function failed(status, recorded) {
  if (!status) return 'no answer';
  if (status >= 500) return `HTTP ${status}`;
  if ((status === 401 || status === 403 || status === 429) && recorded !== status) return `HTTP ${status}`;
  if (status >= 400 && recorded && recorded < 400) return `HTTP ${status} (the browser got ${recorded})`;
  return '';
}

// ---- a user's cookies ------------------------------------------------------
class Jar {
  constructor() { this.m = new Map(); }
  take(setCookies) {
    for (const line of setCookies || []) {
      const first = String(line).split(';')[0];
      const i = first.indexOf('=');
      if (i < 1) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      if (!value || /max-age=0\b|expires=Thu, 01[ -]Jan[ -]1970/i.test(line)) this.m.delete(name); else this.m.set(name, value);
    }
  }
  header() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; '); }
  has(re) { return [...this.m.keys()].some((k) => re.test(k)); }
  clear() { this.m.clear(); }
}

// ---- reading ServiceNow's answers -------------------------------------------
// The page's own token for its data requests.
function findToken(html) {
  const m = String(html || '').match(/g_ck\s*=\s*['"]([0-9a-f]{20,})['"]/i);
  return m ? m[1] : '';
}
// ServiceNow hands a browser to an identity provider with a redirect to
// /auth_redirect.do?...&sysparm_url=<the provider's address, with the request>.
function providerUrl(location, base) {
  try {
    const u = new URL(location, base);
    if (!/\/auth_redirect\.do$/.test(u.pathname)) return '';
    return u.searchParams.get('sysparm_url') || '';
  } catch { return ''; }
}
// The form an identity provider answers with: where to post it, and what.
function parseForm(html) {
  const text = String(html || '');
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#x2b;/gi, '+').replace(/&#43;/g, '+').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const action = (text.match(/<form[^>]*\baction="([^"]*)"/i) || [])[1];
  if (!action) return null;
  const fields = {};
  for (const m of text.matchAll(/<input[^>]*>/gi)) {
    const name = (m[0].match(/\bname="([^"]*)"/i) || [])[1];
    const value = (m[0].match(/\bvalue="([^"]*)"/i) || [])[1];
    if (name) fields[unesc(name)] = unesc(value || '');
  }
  return { action: unesc(action), fields };
}
// A page that belongs to nobody: the login page, or the sign-in pages.
function isLoginPage(url, html) {
  try { if (/\/(login|login_with_sso|login_locate_sso|auth_redirect|external_logout_complete)\.do$/i.test(new URL(url).pathname)) return true; } catch { /* not a URL */ }
  return /name="user_password"/.test(String(html || '').slice(0, 200000));
}

// A recording as it is stored: small, and never with a token or a password in it.
function finish(raw, { steps, user, userId, ssoId }) {
  let token = '';
  let n = 0;
  const out = [];
  for (const st of raw || []) {
    const requests = [];
    for (const r of st.requests || []) {
      if (r.token && !token) token = r.token;
      if (requests.length >= MAX_PER_STEP) break;
      const { token: _drop, ...rest } = r;
      requests.push(rest);
    }
    n += requests.length;
    out.push({ index: st.index, name: st.name || '', ms: st.ms || 0, requests });
  }
  return { at: Date.now(), key: stepsKey(steps), was: { token, user: user || '', userId: userId || '', ssoId: ssoId || '' }, steps: out, requests: n, data: out.reduce((a, s) => a + s.requests.filter((r) => r.t !== 'static').length, 0) };
}

module.exports = { stepsKey, keep, pick, prepare, failed, Jar, findToken, providerUrl, parseForm, isLoginPage, finish, LONG_LIVED };
