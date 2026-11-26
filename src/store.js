'use strict';
// Everything the app keeps is a JSON file under the data folder (UILOAD_DATA,
// default ./data). The folder holds the instance admin password, so it is
// git-ignored and never served.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = path.resolve(process.env.UILOAD_DATA || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA, 'runs'), { recursive: true });

function file(name) { return path.join(DATA, name); }
function read(name, dflt) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return dflt; }
}
function write(name, value) {
  const f = file(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

const DEFAULT_SETTINGS = {
  instances: [],              // [{ id, name, url, user, password, proxy }] - the ServiceNow instances tests can target
  browser: 'chrome',          // chrome | msedge | chromium (Playwright's own, needs `npx playwright-core install chromium`)
  headless: true,
  idpBaseUrl: '',             // where the workers' browsers reach this app; empty = http://127.0.0.1:<port>
  maxBrowsers: 0,             // most browsers at once; 0 = work it out from this machine's size
  maxApiUsers: 0,             // most API users at once; 0 = 2000
  proxies: [],                // [{ name, url }] - forward proxies an instance or a test can go through
};
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
function settings() {
  const raw = read('settings.json', {});
  const s = { ...DEFAULT_SETTINGS, ...raw };
  // The first version kept one connection: it becomes the first instance.
  if (!Array.isArray(raw.instances)) s.instances = raw.instanceUrl ? [{ id: 'default', name: hostOf(raw.instanceUrl) || 'ServiceNow', url: cleanUrl(raw.instanceUrl), user: raw.user || '', password: raw.password || '', proxy: raw.connectionProxy || '' }] : [];
  delete s.instanceUrl; delete s.user; delete s.password; delete s.connectionProxy;
  if (!s.workerToken) { s.workerToken = crypto.randomBytes(24).toString('hex'); write('settings.json', s); }
  return s;
}
// The instance a test or a run names; the first one when it names none.
function instance(s, id) {
  const list = s.instances || [];
  const hit = id ? list.find((x) => x.id === id) : list[0];
  if (!hit) throw new Error(id && list.length ? 'The ServiceNow instance this was made for is no longer configured (ServiceNow > Instances).' : 'No ServiceNow instance is set up yet (ServiceNow > Instances).');
  return hit;
}
function saveSettings(patch) {
  const s = settings();
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (patch[k] !== undefined && k !== 'instances') s[k] = patch[k];
  const { cleanProxy } = require('./http');
  // A proxy sent back with its password masked keeps the saved one.
  const before = s.proxies || [];
  if (patch.proxies !== undefined) {
    const was = read('settings.json', {}).proxies || [];
    s.proxies = (Array.isArray(patch.proxies) ? patch.proxies : []).map((p) => {
      const name = String(p.name || '').trim().slice(0, 40);
      const old = was.find((o) => o.name === name);
      const url = /\*\*\*\*/.test(String(p.url || '')) && old ? old.url : cleanProxy(p.url);
      return { name, url };
    }).filter((p) => p.name && p.url && !['direct', '(connection)'].includes(p.name));
  } else s.proxies = before;
  if (patch.instances !== undefined) {
    const old = s.instances;
    s.instances = (Array.isArray(patch.instances) ? patch.instances : []).map((i) => {
      const prev = old.find((o) => o.id === i.id);
      const url = cleanUrl(i.url);
      return {
        id: prev ? prev.id : crypto.randomBytes(5).toString('hex'), name: String(i.name || '').trim().slice(0, 60) || hostOf(url) || 'ServiceNow', url,
        user: String(i.user || '').trim(), password: i.password ? String(i.password) : (prev ? prev.password : ''), proxy: String(i.proxy || ''),
      };
    }).filter((i) => /^https?:\/\/[^/]+$/i.test(i.url));
  }
  // The single-connection form of the first version still works: it edits the first instance.
  if (patch.instanceUrl !== undefined || patch.user !== undefined || patch.password) {
    const first = s.instances[0] || { id: 'default', name: '', url: '', user: '', password: '', proxy: '' };
    if (patch.instanceUrl !== undefined) { first.url = cleanUrl(patch.instanceUrl); first.name = first.name || hostOf(first.url); }
    if (patch.user !== undefined) first.user = String(patch.user).trim();
    if (patch.password) first.password = String(patch.password);
    if (patch.connectionProxy !== undefined) first.proxy = String(patch.connectionProxy || '');
    if (!s.instances.length && first.url) s.instances.push(first);
  } else if (patch.connectionProxy !== undefined && s.instances[0]) s.instances[0].proxy = String(patch.connectionProxy || '');
  for (const i of s.instances) if (i.proxy && !s.proxies.some((p) => p.name === i.proxy)) i.proxy = '';
  write('settings.json', s);
  return s;
}

function scenarios() { return read('scenarios.json', []); }
function saveScenarios(list) { write('scenarios.json', list); }

function runDir(id) { return path.join(DATA, 'runs', id); }
function saveRun(id, value) { write(path.join('runs', id, 'run.json'), value); }
function readRun(id) { return read(path.join('runs', id, 'run.json'), null); }
function listRuns() {
  let ids = [];
  try { ids = fs.readdirSync(path.join(DATA, 'runs')); } catch { /* none yet */ }
  return ids.map((id) => readRun(id)).filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function saveShot(id, name, buf) {
  const dir = path.join(runDir(id), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
}
function shotPath(id, name) { return path.join(runDir(id), 'shots', path.basename(name)); }
function deleteRun(id) { fs.rmSync(runDir(path.basename(id)), { recursive: true, force: true }); }

module.exports = {
  DATA, read, write, settings, saveSettings, instance, scenarios, saveScenarios,
  saveRun, readRun, listRuns, saveShot, shotPath, deleteRun,
};
