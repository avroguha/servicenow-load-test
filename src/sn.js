'use strict';
// A small ServiceNow REST client (Table API, basic auth) for the admin work:
// checks, creating the temporary records, and deleting them again.
const { request, resolveProxy } = require('./http');

class SNError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

class SN {
  constructor({ instanceUrl, user, password, proxy = '', requestImpl }) {
    if (!instanceUrl || !user || !password) throw new SNError('This ServiceNow instance has no URL, user or password yet (ServiceNow > Instances).', 0);
    this.base = String(instanceUrl).replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    this.userName = user;
    this.proxy = proxy;
    this.request = requestImpl || request;
  }

  // The client for one configured instance (the first when none is named), through its proxy.
  static fromSettings(settings, instanceId) {
    const inst = require('./store').instance(settings, instanceId);
    const sn = new SN({ instanceUrl: inst.url, user: inst.user, password: inst.password, proxy: resolveProxy(settings, inst.proxy || 'direct') });
    sn.instance = { id: inst.id, name: inst.name, url: inst.url, proxy: inst.proxy || '' };
    return sn;
  }

  async req(method, path, body, { tries = 3 } = {}) {
    let last;
    for (let i = 0; i < tries; i += 1) {
      let r;
      try {
        r = await this.request({
          method, url: this.base + path, proxy: this.proxy, timeoutMs: 90000,
          headers: { Authorization: this.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        last = new SNError(`${method} ${path.split('?')[0]}: ${err.cause ? err.cause.message || err.message : err.message}`, 0);
        await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
        continue;
      }
      if (r.status === 204) return null;
      let json = null;
      try { json = JSON.parse(r.text); } catch { /* an HTML page: hibernating instance, gateway error */ }
      if (r.status >= 200 && r.status < 300 && json) return json.result;
      const detail = json && json.error ? `${json.error.message}${json.error.detail ? ` - ${json.error.detail}` : ''}` : r.text.slice(0, 160).replace(/\s+/g, ' ');
      last = new SNError(`${method} ${path.split('?')[0]}: HTTP ${r.status} ${detail}`, r.status);
      if (r.status === 429 || r.status >= 502) { await new Promise((s) => setTimeout(s, 2000 * (i + 1))); continue; }
      throw last;
    }
    throw last;
  }

  query(table, query, fields, limit = 1000, { display = false } = {}) {
    const p = new URLSearchParams({ sysparm_query: query || '', sysparm_limit: String(limit), sysparm_exclude_reference_link: 'true' });
    if (fields) p.set('sysparm_fields', fields);
    if (display) p.set('sysparm_display_value', 'true');
    return this.req('GET', `/api/now/table/${table}?${p}`);
  }
  insert(table, body, { displayValue = false } = {}) {
    const q = `sysparm_exclude_reference_link=true${displayValue ? '&sysparm_input_display_value=true' : ''}`;
    return this.req('POST', `/api/now/table/${table}?${q}`, body);
  }
  patch(table, id, body) { return this.req('PATCH', `/api/now/table/${table}/${id}?sysparm_exclude_reference_link=true`, body); }
  // Deleting something already gone counts as done.
  async remove(table, id) {
    try { await this.req('DELETE', `/api/now/table/${table}/${id}`); return true; } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }
}

// Runs `fn` over `items`, `width` at a time; stops handing out work once `stop()` is true.
async function pool(items, width, fn, stop = () => false) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const at = i; i += 1;
      if (at >= items.length || stop()) return;
      out[at] = await fn(items[at], at);
    }
  }));
  return out;
}

module.exports = { SN, SNError, pool };
