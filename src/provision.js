'use strict';
// What the app creates on the instance for a run, and how it takes it away.
//
// Every record created is written to the run's ledger the moment it exists, and
// carries a marker naming the run, so cleanup has two independent ways to find
// it: the ledger, and a search for the marker. Nothing that was on the instance
// before the run is ever changed: a user name that already exists stops the run
// in the checks, before anything is created.
const crypto = require('node:crypto');
const { pool } = require('./sn');
const { selfSigned } = require('./x509');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,38}$/;
const UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';
const BASIC_ROLE = 'snc_basic_auth_api_access';
const marker = (runId) => `UI load test [run ${runId}]`;

function userNames(prefix, count, pad = 3) {
  const width = Math.max(pad, String(count).length);
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(width, '0')}`);
}
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean);
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// Read-only. Returns the checks for the page and what provisioning needs.
async function preflight(sn, scenario, count) {
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };
  const out = { ok: false, checks, roles: [], groups: [], ssoScriptId: '' };
  const u = scenario.users || {};
  const mode = scenario.authMode;

  if (!add('Temporary user name', NAME_RE.test(u.prefix || ''), NAME_RE.test(u.prefix || '')
    ? `${userNames(u.prefix, count, u.pad)[0]} ... ${userNames(u.prefix, count, u.pad)[count - 1]} (${count})`
    : 'Use 2-39 letters, digits, dot, dash or underscore.')) return out;

  try {
    const me = await sn.query('sys_user', `user_name=${sn.userName}`, 'sys_id,user_name', 1);
    add('Sign in to the instance', me.length === 1, me.length ? `as ${sn.userName}` : 'The admin user cannot read its own record.');
  } catch (err) { add('Sign in to the instance', false, err.message); return out; }

  const wantRoles = list(u.roles);
  if (scenario.type === 'api' && mode === 'basic') {
    // Where the instance restricts basic authentication, an API user needs this role.
    const gate = await sn.query('sys_user_role', `name=${BASIC_ROLE}`, 'sys_id', 1);
    if (gate.length && !wantRoles.includes(BASIC_ROLE)) wantRoles.push(BASIC_ROLE);
  }
  for (const [kind, table, target, wanted] of [['Roles', 'sys_user_role', 'roles', wantRoles], ['Groups', 'sys_user_group', 'groups', list(u.groups)]]) {
    if (!wanted.length) { add(kind, true, 'none'); continue; }
    const found = await sn.query(table, `nameIN${wanted.join(',')}`, 'sys_id,name');
    const missing = wanted.filter((w) => !found.some((f) => f.name === w));
    out[target] = wanted.filter((w) => !missing.includes(w)).map((w) => found.find((f) => f.name === w));
    add(kind, !missing.length, missing.length ? `Not on the instance: ${missing.join(', ')}` : wanted.join(', '));
  }

  const names = userNames(u.prefix, count, u.pad);
  const taken = await sn.query('sys_user', `user_nameSTARTSWITH${u.prefix}`, 'user_name,title');
  const clash = taken.filter((t) => names.includes(t.user_name));
  add('User names are free', !clash.length, clash.length
    ? `Already on the instance: ${clash.slice(0, 5).map((c) => c.user_name).join(', ')}${clash.length > 5 ? ` and ${clash.length - 5} more` : ''}. `
      + (clash.some((c) => /^UI load test/.test(c.title)) ? 'They are left from an earlier run - clean it up under ServiceNow > Records on the instance.' : 'Choose another name; existing users are never touched.')
    : 'no existing user has these names');

  if (mode === 'local') {
    try {
      const prop = await sn.query('sys_properties', 'name=glide.authenticate.multisso.enabled', 'value', 1);
      const on = prop.length && prop[0].value === 'true';
      const acr = on ? await sn.query('sys_properties', 'name=glide.sso.acr.enabled', 'value', 1) : [];
      const blocked = on && acr.length && acr[0].value === 'true';
      // A note, never a stop: whether login.do works beside SSO is the instance's own setting.
      add('Local sign-in', true, blocked
        ? 'Expect this to fail: Multi-Provider SSO and account recovery are both on, so the instance accepts user name and password only from accounts enrolled in account recovery. Use Mock SSO for this test.'
        : on ? 'Multi-Provider SSO is on. User name and password work only if the instance allows local login beside SSO; if the test lands back on the login page, use Mock SSO.'
          : 'Multi-Provider SSO is off, so user name and password work');
      if (blocked) checks[checks.length - 1].warn = true;
    } catch (err) { add('Local sign-in', true, `could not read the SSO setting: ${err.message}`); }
  }
  if (mode === 'sso') {
    try {
      const prop = await sn.query('sys_properties', 'name=glide.authenticate.multisso.enabled', 'value', 1);
      const on = prop.length && prop[0].value === 'true';
      add('Multi-Provider SSO is on', on, on ? 'glide.authenticate.multisso.enabled = true'
        : 'glide.authenticate.multisso.enabled is not true. This app does not change it: it is an instance-wide setting. Turn it on (Multi-Provider SSO > Administration > Properties) or use local sign-in for the test users.');
      const si = await sn.query('sys_script_include', 'name=MultiSSOv2_SAML2_custom', 'sys_id', 1);
      out.ssoScriptId = si.length ? si[0].sys_id : '';
      add('SAML sign-in script', !!out.ssoScriptId, out.ssoScriptId ? 'MultiSSOv2_SAML2_custom' : 'Script include MultiSSOv2_SAML2_custom not found - is the Multi-Provider SSO plugin active?');
      const col = await sn.query('sys_dictionary', 'name=sys_user^element=sso_source', 'element', 1);
      add('Per-user SSO source', col.length === 1, col.length ? 'sys_user.sso_source' : 'sys_user has no sso_source field - the Multi-Provider SSO plugin is not active.');
    } catch (err) { add('Multi-Provider SSO', false, err.message); }
  }
  if (mode === 'oauth') {
    try { await sn.query('oauth_entity', 'sys_idISEMPTY', 'sys_id', 1); add('OAuth application registry', true, 'a temporary OAuth client will be created for the run'); } catch (err) { add('OAuth application registry', false, err.message); }
  }
  out.ok = checks.every((c) => c.ok);
  return out;
}

// Creates what the run needs: the identity provider record (Mock SSO), the
// OAuth client (API with OAuth) and the users. `ledger(rec)` is called for each
// record created; `stop()` true makes it return early.
async function provision(sn, { runId, scenario, count, pre, idpBaseUrl, ledger, log, stop }) {
  const u = scenario.users;
  const mode = scenario.authMode;
  const out = { users: [], sso: null, oauth: null, password: '' };
  const mark = marker(runId);

  if (mode === 'sso') {
    const cert = selfSigned({ commonName: `uiload-${runId}` });
    const entityId = `urn:uiload:${runId}`;
    const c = await sn.insert('sys_certificate', {
      name: `${mark} certificate`, format: 'pem', type: 'trust_store', pem_certificate: cert.certPem, active: 'true',
      short_description: 'Temporary. Created by the UI load test tool and deleted when the run stops.',
    });
    ledger({ table: 'sys_certificate', id: c.sys_id, label: c.name });
    const rec = await sn.insert('saml2_update1_properties', {
      name: `${mark} identity provider`,
      idp: entityId,
      idp_authnrequest_url: `${idpBaseUrl}/idp/sso`,
      idp_logout_url: `${idpBaseUrl}/idp/logout`,
      service_url: `${sn.base}/navpage.do`, issuer: sn.base, audience: sn.base,
      nameid_policy: UNSPECIFIED, user_field: 'user_name',
      x509_certificate: c.sys_id, sso_script: pre.ssoScriptId,
      // Not the default, not offered on the login page, never redirected to on
      // its own: only a user whose sso_source names this record is sent here.
      active: 'true', default: 'false', is_primary: 'false', show_as_login_option: 'false',
      is_test_connection_successful: 'true', createrequestedauthncontext: 'false',
      auto_provision: 'false', auto_update_user: 'false',
    });
    ledger({ table: 'saml2_update1_properties', id: rec.sys_id, label: rec.name });
    // ServiceNow looks the certificate up through this link table, not the field above.
    const link = await sn.insert('idp_certificate', { idp: rec.sys_id, x509_certificate: c.sys_id });
    ledger({ table: 'idp_certificate', id: link.sys_id, label: `${mark} certificate link` });
    out.sso = { id: rec.sys_id, entityId, key: cert.privateKey, certB64: cert.certB64, audience: sn.base, acsUrl: `${sn.base}/navpage.do` };
    log(`Identity provider record created (not default, not on the login page): ${rec.name}`);
  } else {
    out.password = `Lt-${crypto.randomBytes(18).toString('base64url')}9a`;
  }

  if (mode === 'oauth') {
    const clientId = crypto.randomBytes(16).toString('hex');
    const clientSecret = crypto.randomBytes(24).toString('base64url');
    const rec = await sn.insert('oauth_entity', {
      name: `${mark} OAuth client`, type: 'client', client_id: clientId, client_secret: clientSecret, active: 'true',
      access_token_lifespan: '7200', refresh_token_lifespan: '7200',
      comments: 'Temporary. Created by the UI load test tool and deleted when the run stops.',
    });
    ledger({ table: 'oauth_entity', id: rec.sys_id, label: rec.name });
    out.oauth = { id: rec.sys_id, clientId, clientSecret };
    log(`Temporary OAuth client created: ${rec.name}`);
  }

  const names = userNames(u.prefix, count, u.pad);
  let done = 0;
  await pool(names, 6, async (name, i) => {
    const body = {
      user_name: name, first_name: u.firstName || 'Load', last_name: `Test ${name.slice(u.prefix.length)}`,
      title: mark, active: 'true', locked_out: 'false', password_needs_reset: 'false',
    };
    if (out.sso) body.sso_source = `sso:${out.sso.id}`; else body.user_password = out.password;
    // An API user is an integration account: it never signs in to the UI.
    if (scenario.type === 'api') body.web_service_access_only = 'true';
    const rec = await sn.insert('sys_user', body, { displayValue: !out.sso });
    ledger({ table: 'sys_user', id: rec.sys_id, label: name });
    for (const r of pre.roles) await sn.insert('sys_user_has_role', { user: rec.sys_id, role: r.sys_id });
    for (const g of pre.groups) await sn.insert('sys_user_grmember', { user: rec.sys_id, group: g.sys_id });
    out.users[i] = { name, id: rec.sys_id };
    done += 1;
    if (done % 10 === 0 || done === names.length) log(`Users created: ${done} of ${names.length}`);
  }, stop);
  out.users = out.users.filter(Boolean);
  return out;
}

// Deletes everything a run created. Safe to run again: what is already gone
// counts as done. Returns what could not be deleted and what is still found.
async function cleanup(sn, { runId, ledger, log }) {
  const failed = [];
  let deleted = 0;
  const mark = marker(runId);
  const found = new Map();                      // `${table}:${id}` -> record
  for (const r of ledger || []) found.set(`${r.table}:${r.id}`, r);
  const sweep = async () => {
    const hits = [];
    for (const [table, q, f] of [
      ['sys_user', `title=${mark}`, 'user_name'],
      ['saml2_update1_properties', `nameSTARTSWITH${mark}`, 'name'],
      ['sys_certificate', `nameSTARTSWITH${mark}`, 'name'],
      ['oauth_entity', `nameSTARTSWITH${mark}`, 'name'],
    ]) {
      try {
        for (const r of await sn.query(table, q, `sys_id,${f}`, 10000)) hits.push({ table, id: r.sys_id, label: r[f] });
      } catch (err) { if (err.status !== 400 && err.status !== 403) throw err; }   // table absent without the plugin
    }
    return hits;
  };
  for (const r of await sweep()) found.set(`${r.table}:${r.id}`, r);

  // The certificate links of this run's identity provider records.
  const idps = [...found.values()].filter((r) => r.table === 'saml2_update1_properties').map((r) => r.id);
  if (idps.length) {
    try { for (const r of await sn.query('idp_certificate', `idpIN${idps.join(',')}`, 'sys_id')) found.set(`idp_certificate:${r.sys_id}`, { table: 'idp_certificate', id: r.sys_id, label: 'certificate link' }); } catch (err) { if (err.status !== 400 && err.status !== 403) throw err; }
  }
  const all = [...found.values()];
  const users = all.filter((r) => r.table === 'sys_user');

  // Tokens first, while the users and the client they belong to still exist.
  const tokens = [];
  const clients = all.filter((r) => r.table === 'oauth_entity').map((r) => r.id);
  if (clients.length) {
    try { for (const r of await sn.query('oauth_credential', `peerIN${clients.join(',')}`, 'sys_id', 10000)) tokens.push({ table: 'oauth_credential', id: r.sys_id }); } catch { /* not readable: the client's deletion takes them */ }
  }
  await pool(tokens, 6, async (r) => { try { await sn.remove(r.table, r.id); } catch { /* removed with the client */ } });

  const order = ['sys_user', 'idp_certificate', 'saml2_update1_properties', 'sys_certificate', 'oauth_entity'];
  for (const table of order) {
    const rows = all.filter((r) => r.table === table);
    let n = 0;
    await pool(rows, 6, async (r) => {
      try { await sn.remove(table, r.id); deleted += 1; } catch (err) { failed.push({ ...r, error: err.message }); }
      n += 1;
      if (table === 'sys_user' && (n % 20 === 0 || n === rows.length)) log(`Users deleted: ${n} of ${rows.length}`);
    });
  }

  // What a deleted user can leave behind, and the update-set entries the
  // configuration records wrote into the admin's current update set.
  const leftovers = [];
  for (const ids of chunks(users.map((x) => x.id), 40)) {
    for (const [table, field] of [['sys_user_has_role', 'user'], ['sys_user_grmember', 'user'], ['sys_user_preference', 'user']]) {
      try { for (const r of await sn.query(table, `${field}IN${ids.join(',')}`, 'sys_id', 10000)) leftovers.push({ table, id: r.sys_id }); } catch { /* not readable: nothing to do */ }
    }
  }
  const tracked = all.filter((r) => !['sys_user', 'idp_certificate'].includes(r.table)).map((r) => `${r.table}_${r.id}`);
  if (tracked.length) {
    try { for (const r of await sn.query('sys_update_xml', `nameIN${tracked.join(',')}`, 'sys_id')) leftovers.push({ table: 'sys_update_xml', id: r.sys_id }); } catch { /* ignore */ }
  }
  await pool(leftovers, 6, async (r) => { try { await sn.remove(r.table, r.id); } catch (err) { failed.push({ ...r, label: r.table, error: err.message }); } });

  const remaining = await sweep();
  log(remaining.length || failed.length
    ? `Cleanup incomplete: ${remaining.length} record(s) still on the instance, ${failed.length} error(s).`
    : `Cleanup complete: ${deleted} record(s) deleted, nothing left on the instance.`);
  return { deleted, failed, remaining, complete: !remaining.length && !failed.length, at: Date.now() };
}

module.exports = { preflight, provision, cleanup, userNames, marker, list, NAME_RE, BASIC_ROLE };
