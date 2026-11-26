'use strict';
const test = require('node:test');
const assert = require('node:assert');
const prov = require('../src/provision');

// A tiny in-memory instance that understands the queries the app sends.
function fakeSN(seed = {}) {
  const tables = { sys_user: [], sys_user_role: [], sys_user_group: [], sys_user_has_role: [], sys_user_grmember: [], sys_user_preference: [], sys_properties: [], sys_script_include: [], sys_dictionary: [], sys_certificate: [], saml2_update1_properties: [], idp_certificate: [], oauth_entity: [], oauth_credential: [], sys_update_xml: [], ...seed };
  let n = 0;
  const match = (row, q) => q.split('^').every((part) => {
    let m;
    if (!part) return true;
    if ((m = part.match(/^([\w.]+)STARTSWITH(.*)$/))) return String(row[m[1]] || '').startsWith(m[2]);
    if ((m = part.match(/^([\w.]+)IN(.*)$/))) return m[2].split(',').includes(String(row[m[1]]));
    if ((m = part.match(/^([\w.]+)=(.*)$/))) return String(row[m[1]]) === m[2];
    throw new Error(`fake: cannot read "${part}"`);
  });
  return {
    base: 'https://x.example', userName: 'admin', tables, deleted: [],
    async query(t, q) { return tables[t].filter((r) => match(r, q || '')); },
    async insert(t, body) { n += 1; const row = { sys_id: `id${n}`, ...body }; tables[t].push(row); return row; },
    async patch(t, id, body) { const row = tables[t].find((r) => r.sys_id === id); if (!row) throw Object.assign(new Error('HTTP 404'), { status: 404 }); Object.assign(row, body); return row; },
    async remove(t, id) { const i = tables[t].findIndex((r) => r.sys_id === id); if (i < 0) return false; tables[t].splice(i, 1); this.deleted.push(`${t}:${id}`); return true; },
  };
}
const seed = () => ({
  sys_user: [{ sys_id: 'adm', user_name: 'admin', title: '' }, { sys_id: 'real', user_name: 'lt.user.keep', title: 'A real person' }],
  sys_user_role: [{ sys_id: 'r1', name: 'itil' }], sys_user_group: [{ sys_id: 'g1', name: 'Service Desk' }],
  sys_properties: [{ name: 'glide.authenticate.multisso.enabled', value: 'true' }],
  sys_script_include: [{ sys_id: 'si', name: 'MultiSSOv2_SAML2_custom' }], sys_dictionary: [{ name: 'sys_user', element: 'sso_source' }],
});
const ssoOff = () => { const s = seed(); s.sys_properties[0].value = 'false'; return s; };
const scenario = (over = {}) => ({ authMode: 'sso', users: { prefix: 'lt.user.', pad: 3, roles: ['itil'], groups: ['Service Desk'] }, ...over });
const quietly = { log() {}, stop: () => false };

test('user names are numbered and padded', () => {
  assert.deepStrictEqual(prov.userNames('lt.', 2), ['lt.001', 'lt.002']);
  assert.strictEqual(prov.userNames('lt.', 1200)[1199], 'lt.1200');
});

test('checks pass on a ready instance and create nothing', async () => {
  const sn = fakeSN(seed());
  const pre = await prov.preflight(sn, scenario(), 3);
  assert.ok(pre.ok, JSON.stringify(pre.checks));
  assert.strictEqual(sn.tables.sys_user.length, 2);
});

test('checks stop the run: a missing role, a taken name, SSO switched off, a bad name', async () => {
  let pre = await prov.preflight(fakeSN(seed()), scenario({ users: { prefix: 'lt.user.', roles: ['nope'], groups: [] } }), 1);
  assert.ok(!pre.ok); assert.match(JSON.stringify(pre.checks), /Not on the instance: nope/);

  const taken = seed(); taken.sys_user.push({ sys_id: 'x', user_name: 'lt.user.002', title: 'Somebody' });
  pre = await prov.preflight(fakeSN(taken), scenario(), 3);
  assert.ok(!pre.ok); assert.match(JSON.stringify(pre.checks), /lt\.user\.002/);

  const off = seed(); off.sys_properties[0].value = 'false';
  pre = await prov.preflight(fakeSN(off), scenario(), 1);
  assert.ok(!pre.ok); assert.match(JSON.stringify(pre.checks), /does not change it/);
  assert.ok((await prov.preflight(fakeSN(off), scenario({ authMode: 'local' }), 1)).ok, 'local sign-in does not need SSO');
  pre = await prov.preflight(fakeSN(seed()), scenario({ authMode: 'local' }), 1);
  assert.ok(pre.ok, 'SSO being on is a note for local sign-in, not a stop'); assert.match(JSON.stringify(pre.checks), /use Mock SSO/);

  pre = await prov.preflight(fakeSN(seed()), scenario({ users: { prefix: 'a b', roles: [], groups: [] } }), 1);
  assert.ok(!pre.ok);
});

test('SSO run: only its own users point at the identity provider, and cleanup removes everything', async () => {
  const sn = fakeSN(seed());
  const pre = await prov.preflight(sn, scenario(), 3);
  const ledger = [];
  const made = await prov.provision(sn, { runId: 'run1', scenario: scenario(), count: 3, pre, idpBaseUrl: 'http://127.0.0.1:8787', ledger: (r) => ledger.push(r), ...quietly });
  assert.strictEqual(made.users.length, 3);
  const rec = sn.tables.saml2_update1_properties[0];
  assert.strictEqual(rec.default, 'false'); assert.strictEqual(rec.show_as_login_option, 'false'); assert.strictEqual(rec.is_primary, 'false');
  assert.strictEqual(rec.auto_provision, 'false'); assert.strictEqual(rec.user_field, 'user_name');
  assert.strictEqual(rec.idp_authnrequest_url, 'http://127.0.0.1:8787/idp/sso');
  const mine = sn.tables.sys_user.filter((u) => u.sso_source);
  assert.deepStrictEqual(mine.map((u) => u.user_name), ['lt.user.001', 'lt.user.002', 'lt.user.003']);
  assert.ok(mine.every((u) => u.sso_source === `sso:${rec.sys_id}` && !u.user_password));
  assert.strictEqual(sn.tables.sys_user_has_role.length, 3); assert.strictEqual(sn.tables.sys_user_grmember.length, 3);
  assert.strictEqual(ledger.length, 6);
  assert.deepStrictEqual(sn.tables.idp_certificate.map((l) => [l.idp, l.x509_certificate]), [[rec.sys_id, sn.tables.sys_certificate[0].sys_id]]);

  // Cleanup with an EMPTY ledger (as after a crash): the marker finds everything.
  sn.tables.sys_update_xml.push({ sys_id: 'ux', name: `saml2_update1_properties_${rec.sys_id}` }, { sys_id: 'other', name: 'sys_script_abc' });
  const res = await prov.cleanup(sn, { runId: 'run1', ledger: [], log() {} });
  assert.ok(res.complete, JSON.stringify(res));
  assert.deepStrictEqual(sn.tables.sys_user.map((u) => u.user_name), ['admin', 'lt.user.keep'], 'people who were there before are untouched');
  for (const t of ['saml2_update1_properties', 'sys_certificate', 'idp_certificate', 'sys_user_has_role', 'sys_user_grmember']) assert.strictEqual(sn.tables[t].length, 0, t);
  assert.deepStrictEqual(sn.tables.sys_update_xml.map((x) => x.sys_id), ['other']);
  assert.ok((await prov.cleanup(sn, { runId: 'run1', ledger, log() {} })).complete, 'running it again is harmless');
});

test('local run: users get a password, no SSO record; cleanup only takes its own run', async () => {
  const sn = fakeSN(ssoOff());
  const sc = scenario({ authMode: 'local' });
  const pre = await prov.preflight(sn, sc, 2);
  const a = [];
  const one = await prov.provision(sn, { runId: 'runA', scenario: sc, count: 2, pre, ledger: (r) => a.push(r), ...quietly });
  assert.ok(one.password.length > 20); assert.strictEqual(sn.tables.saml2_update1_properties.length, 0);
  const sc2 = scenario({ authMode: 'local', users: { prefix: 'other.', roles: [], groups: [] } });
  await prov.provision(sn, { runId: 'runB', scenario: sc2, count: 1, pre: { roles: [], groups: [] }, ledger() {}, ...quietly });
  await prov.cleanup(sn, { runId: 'runA', ledger: a, log() {} });
  assert.deepStrictEqual(sn.tables.sys_user.map((u) => u.user_name), ['admin', 'lt.user.keep', 'other.001']);
});

test('a failed delete is reported, not hidden', async () => {
  const sn = fakeSN(ssoOff());
  const sc = scenario({ authMode: 'local' });
  const ledger = [];
  await prov.provision(sn, { runId: 'runC', scenario: sc, count: 1, pre: await prov.preflight(sn, sc, 1), ledger: (r) => ledger.push(r), ...quietly });
  sn.remove = async () => { throw new Error('HTTP 403'); };
  const res = await prov.cleanup(sn, { runId: 'runC', ledger, log() {} });
  assert.ok(!res.complete); assert.strictEqual(res.remaining.length, 1); assert.ok(res.failed.length >= 1);
});

test('API test with basic authentication: web-service-only users, and the role the instance asks for', async () => {
  const s = ssoOff(); s.sys_user_role.push({ sys_id: 'rb', name: prov.BASIC_ROLE });
  const sn = fakeSN(s);
  const sc = { type: 'api', authMode: 'basic', users: { prefix: 'api.user.', pad: 3, roles: [], groups: [] } };
  const pre = await prov.preflight(sn, sc, 2);
  assert.ok(pre.ok, JSON.stringify(pre.checks));
  assert.deepStrictEqual(pre.roles.map((r) => r.name), [prov.BASIC_ROLE]);
  const ledger = [];
  const made = await prov.provision(sn, { runId: 'runD', scenario: sc, count: 2, pre, ledger: (r) => ledger.push(r), ...quietly });
  const mine = sn.tables.sys_user.filter((u) => u.user_name.startsWith('api.user.'));
  assert.ok(mine.every((u) => u.web_service_access_only === 'true' && u.user_password === made.password));
  assert.strictEqual(sn.tables.sys_user_has_role.length, 2);
  assert.ok((await prov.cleanup(sn, { runId: 'runD', ledger, log() {} })).complete);
});

test('API test with OAuth: a temporary client is created and removed with its tokens', async () => {
  const sn = fakeSN(ssoOff());
  const sc = { type: 'api', authMode: 'oauth', users: { prefix: 'api.user.', pad: 3, roles: [], groups: [] } };
  const pre = await prov.preflight(sn, sc, 1);
  assert.ok(pre.ok, JSON.stringify(pre.checks));
  const made = await prov.provision(sn, { runId: 'runE', scenario: sc, count: 1, pre, ledger() {}, ...quietly });
  assert.strictEqual(made.oauth.clientId.length, 32);
  const client = sn.tables.oauth_entity[0];
  assert.strictEqual(client.type, 'client'); assert.strictEqual(client.client_id, made.oauth.clientId);
  sn.tables.oauth_credential.push({ sys_id: 'tok1', peer: client.sys_id }, { sys_id: 'tok2', peer: 'someone-else' });
  const res = await prov.cleanup(sn, { runId: 'runE', ledger: [], log() {} });
  assert.ok(res.complete, JSON.stringify(res));
  assert.strictEqual(sn.tables.oauth_entity.length, 0);
  assert.deepStrictEqual(sn.tables.oauth_credential.map((t) => t.sys_id), ['tok2'], 'only this client\'s tokens go');
});

// ---- an instance that refuses the identity provider record -------------------
const idpFields = () => ({
  core: { name: 'UI load test [run r9] identity provider', idp: 'urn:uiload:r9', idp_authnrequest_url: 'http://127.0.0.1:8787/idp/sso', service_url: 'https://x.example/navpage.do', issuer: 'https://x.example', audience: 'https://x.example', nameid_policy: 'unspecified' },
  needed: { user_field: 'user_name', x509_certificate: 'cert1', sso_script: 'si' },
  safe: { default: 'false', is_primary: 'false', show_as_login_option: 'false', auto_provision: 'false', auto_update_user: 'false' },
  extra: { is_test_connection_successful: 'true', createrequestedauthncontext: 'false' },
});
const refusal = () => Object.assign(new Error('POST /api/now/table/saml2_update1_properties: HTTP 403 Operation Failed - Error during insert of saml2_update1_properties (x)'), { status: 403 });
// refuse(body, how) -> true to refuse that write
function pickySN(refuse, seedOver = {}) {
  const sn = fakeSN({ ...seed(), syslog: [], ...seedOver });
  const insert = sn.insert.bind(sn); const patch = sn.patch.bind(sn);
  sn.insert = async (t, body, o) => { if (t === 'saml2_update1_properties' && refuse(body, 'insert')) throw refusal(); return insert(t, body, o); };
  sn.patch = async (t, id, body) => { if (refuse(body, 'patch')) throw Object.assign(new Error('PATCH x: HTTP 403 Operation Failed'), { status: 403 }); return patch(t, id, body); };
  return sn;
}

test('an instance that refuses the record in one step gets it built inactive, field by field, and switched on last', async () => {
  const sn = pickySN((body, how) => how === 'insert' && body.active === 'true');
  const ledger = []; const notes = [];
  const rec = await prov.createIdp(sn, idpFields(), { ledger: (r) => ledger.push(r), log: (t) => notes.push(t) });
  const row = sn.tables.saml2_update1_properties[0];
  assert.strictEqual(row.sys_id, rec.sys_id);
  assert.deepStrictEqual([row.active, row.x509_certificate, row.sso_script, row.default, row.auto_provision], ['true', 'cert1', 'si', 'false', 'false']);
  assert.strictEqual(ledger.length, 1, 'the record is in the ledger from the moment it exists, so cleanup finds it whatever happens next');
  assert.match(notes.join(' '), /field by field/);
});

test('a refusal is explained: a twin entity id, a missing role, a field, the activation', async () => {
  const opts = { ledger() {}, log() {} };
  // an existing record with the same entity id - the one cause ServiceNow gives this very message for
  let sn = pickySN(() => true, { saml2_update1_properties: [{ sys_id: 'old', name: 'Company SSO', idp: 'urn:uiload:r9', active: 'true' }] });
  await assert.rejects(prov.createIdp(sn, idpFields(), opts), /already has an identity provider record with the entity id urn:uiload:r9 \("Company SSO"\)/);
  assert.strictEqual(sn.tables.saml2_update1_properties.length, 1, 'the existing record is not touched');

  // nothing can be inserted, and the account lacks the role
  sn = pickySN((b, how) => how === 'insert', { sys_user_has_role: [] });
  await assert.rejects(prov.createIdp(sn, idpFields(), opts), /has neither the admin nor the sso_config_admin role/);

  // a field the sign-in needs is refused: the error names it, and the half-built record is in the ledger
  sn = pickySN((b, how) => (how === 'insert' && b.active === 'true') || (how === 'patch' && 'x509_certificate' in b));
  const ledger = [];
  await assert.rejects(prov.createIdp(sn, idpFields(), { ledger: (r) => ledger.push(r), log() {} }), /refuses the value "cert1" for the field x509_certificate/);
  assert.strictEqual(ledger.length, 1);

  // an optional field is refused: noted, not fatal
  sn = pickySN((b, how) => (how === 'insert' && b.active === 'true') || (how === 'patch' && 'is_test_connection_successful' in b));
  const notes = [];
  await prov.createIdp(sn, idpFields(), { ledger() {}, log: (t) => notes.push(t) });
  assert.match(notes.join(' '), /refused is_test_connection_successful = true/);
  assert.strictEqual(sn.tables.saml2_update1_properties[0].active, 'true');

  // everything accepted except switching it on
  sn = pickySN((b, how) => (how === 'insert' && b.active === 'true') || (how === 'patch' && b.active === 'true'));
  await assert.rejects(prov.createIdp(sn, idpFields(), opts), /refuses to activate it[\s\S]*Test Connection[\s\S]*Use local sign-in/);

  // a record that will not give up being the default is never left active
  sn = pickySN((b, how) => (how === 'insert' && b.active === 'true') || (how === 'patch' && 'default' in b));
  const ins = sn.insert; sn.insert = async (t, body, o) => ins(t, t === 'saml2_update1_properties' ? { ...body, default: 'true' } : body, o);
  await assert.rejects(prov.createIdp(sn, idpFields(), opts), /came out with default switched on/);
  assert.notStrictEqual(sn.tables.saml2_update1_properties[0].active, 'true');
});
