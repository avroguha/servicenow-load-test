'use strict';
// When a run has failures, the app looks for the reason on the instance itself
// and says what to do, in plain words. Nobody should need to know where
// ServiceNow hides these answers.
//
// Each rule here was learned the hard way on a real instance: the page shown to
// the user is often wrong or silent ("User name or password invalid" for an
// account that an authentication policy refuses), while the real reason sits in
// the event log, the system log or the knowledge base's own access rules.

// Why the admin connection itself is refused. Nothing can be read from the
// instance in that case, so this is a list of causes, most likely first.
function connectionHints(message) {
  const m = String(message || '');
  if (/HTTP 401/.test(m)) {
    return [
      'ServiceNow refused this user for REST (HTTP 401). The password may be right and the account still not allowed. Check, in this order:',
      '1. "Password needs reset" is ticked on the user record. The Set Password dialog ticks it, and REST then answers 401 without counting a failed attempt. Untick it.',
      '2. The instance restricts basic authentication (property glide.authenticate.basic_auth.restriction.enforce = true). The user then needs the role snc_basic_auth_api_access - the admin role does not include it.',
      '3. The account is a person with multi-factor authentication. REST cannot answer the authenticator prompt. Use an integration account: Identity type = Machine, "Web service access only" ticked, no authenticator.',
      '4. The user is locked out or inactive, or the password is wrong. Avoid special characters lost in copy and paste.',
    ];
  }
  if (/HTTP 403/.test(m)) return ['ServiceNow knows this user but refuses the request (HTTP 403). The user needs the admin role to create users, roles, group memberships and the temporary sign-in records.'];
  if (/proxy/i.test(m)) return ['The proxy could not be used. Check its address and port, and whether it needs a user name and password.'];
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return ['The instance name could not be resolved from this machine. Check the URL; if the instance is only reachable through a proxy, choose one below.'];
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|time limit|timeout/i.test(m)) return ['This machine cannot reach the instance. If it is only reachable through a proxy, choose one below. A developer instance that has been idle is asleep: wake it in the developer portal.'];
  if (/HTTP 5\d\d|<html|hibernat/i.test(m)) return ['The instance answered with an error page. A developer instance that has been idle is asleep (wake it in the developer portal); otherwise the instance may be restarting.'];
  return [];
}

// Logged by ServiceNow's own SAML script when SNC.SSOUtils.generateRequestId() returns nothing. That call reads
// the HTTP session of the request (verified on a Brazil instance), so it is about the REQUEST, not the answer.
const NO_SESSION = /request id is empty/i;
const SAML = [
  [/Unable to locate the SAML 2\.0 Certificate/i, 'ServiceNow could not find the certificate of the temporary identity provider. This app links it through the idp_certificate table; if that table is missing on this release, Mock SSO cannot work here.'],
  [/InResponseTo/i, 'ServiceNow did not recognise the sign-in answer as belonging to its own request. This happens when the browser loses its ServiceNow session cookie between the two redirects.'],
  [NO_SESSION, 'ServiceNow failed while building a sign-in request, because that request had no browser session on the instance. The identity provider of this app did answer during this run, so this log line may belong to another visitor: the system log is shared by everyone on the instance.'],
  [/audience/i, 'The audience in the sign-in answer does not match the instance. Check that the Instance URL under ServiceNow > Connection is exactly the address users open, with no alias or trailing path.'],
  [/NotBefore|NotOnOrAfter|expired|clock/i, 'The clocks of this machine and the instance disagree by more than the allowed skew. Correct this machine\'s clock (NTP).'],
  [/signature|digest/i, 'ServiceNow rejected the signature of the sign-in answer.'],
  [/User: .* not found|Ensure that the user you are trying/i, 'ServiceNow did not find the user named in the sign-in answer. The temporary user may have been deleted while the run was going.'],
];

async function diagnose(sn, run) {
  const sc = run.scenario;
  const prefix = sc.users.prefix;
  const mins = Math.ceil((Date.now() - run.createdAt) / 60000) + 2;
  const since = `sys_created_on>=javascript:gs.minutesAgoStart(${mins})`;
  const out = [];
  const add = (title, detail, evidence) => { if (!out.some((o) => o.title === title)) out.push({ title, detail, evidence: (evidence || []).slice(0, 6) }); };
  const q = (table, query, fields, limit = 20, opts) => sn.query(table, query, fields, limit, opts).catch(() => []);
  const errors = [...(run.steps || []).map((s) => s.lastError || ''), ...(run.shots || []).map((s) => s.error || ''), ...(run.trace || []).map((s) => s.error || '')].filter(Boolean);
  const seen = (re) => errors.some((e) => re.test(e));
  if (!errors.length) return out;

  // 1. The single sign-on answer was refused: ServiceNow logs why.
  if (sc.authMode === 'sso') {
    const logs = await q('syslog', `${since}^source=SAML2^level>=2`, 'message', 12);
    const texts = [...new Set(logs.map((l) => String(l.message).replace(/\s+/g, ' ').slice(0, 220)))];
    // What this app saw itself: where the browser was sent, what it holds, and whether the identity provider was ever asked.
    const failed = (run.steps || []).find((s) => s.errors && s.lastPath);
    const path = failed ? failed.lastPath : [];
    const cookies = failed ? failed.lastCookies : null;
    const asked = run.idpStats || { issued: 0, refused: 0 };
    const facts = [];
    if (path.length) facts.push(`The browser was sent: ${path.join('  ->  ')}`);
    if (cookies) facts.push(cookies.length ? `Cookies the browser holds for the instance: ${cookies.join(', ')}` : 'The browser holds no cookie for the instance at all.');
    facts.push(`This app's identity provider answered ${asked.issued} sign-in request(s) and refused ${asked.refused}.`);
    const sentToIdp = path.some((p) => /\/idp\/sso$/.test(p));
    const noSession = texts.filter((t) => NO_SESSION.test(t));
    if (run.idpStats && !asked.issued && !asked.refused) {
      if (noSession.length && !sentToIdp) {
        const held = cookies && !cookies.some((c) => /JSESSIONID/i.test(c))
          ? 'The browser holds no JSESSIONID cookie (see below): the instance, or a proxy or gateway in front of it, did not give this browser a session.'
          : 'Whether the browser holds a session cookie is listed below; if it does, the session was not there, or not used, on the request that started the sign-in.';
        add('ServiceNow could not start the single sign-on',
          `ServiceNow failed while building its sign-in request, before sending the browser anywhere. Its log says the request id is empty: ServiceNow takes that id from the browser session of the request, so the request that asked for single sign-on had no session on the instance. ${held} Try the same test with "Sign in first" instead of arriving through the link, and without the proxy if the instance can be reached directly: the path below shows which change makes the difference.`,
          [...facts, noSession[0]]);
      } else if (sentToIdp) {
        add('The browser was sent to the test identity provider but did not get an answer', 'ServiceNow sent the browser to this app, and the request never arrived here. The browser cannot open that address: check the address of this app the browsers use (Capacity and workers), and that the proxy is not used for it.', facts);
      } else {
        add('ServiceNow never sent the browser to the test identity provider', 'The sign-in did not get as far as this app. Either ServiceNow sent the browser to another identity provider (see the path below: an instance that sends everyone to its company sign-on page first), or it stopped before sending it anywhere.', [...facts, ...texts.slice(0, 2)]);
      }
    } else if (run.idpStats && asked.refused && !asked.issued) {
      add('The test identity provider refused the browser', 'The browser reached this app without the ticket of a test user. This happens when the browsers reach this app under another address than the one the ticket was made for.', facts);
    } else {
      for (const [re, advice] of SAML) if (texts.some((t) => re.test(t))) add('ServiceNow rejected the single sign-on answer', advice, [...texts.filter((t) => re.test(t)).slice(0, 3), ...facts]);
      if (texts.length && !out.length) add('ServiceNow rejected the single sign-on answer', 'The instance logged the reason below (System Log, source SAML2).', [...texts.slice(0, 3), ...facts]);
    }
  }

  // 2. A sign-in the page calls "invalid" is often a policy refusal: the event log tells the truth.
  const events = await q('sysevent', `${since}^nameLIKEauthentication.failed^ORname=login.failed^parm1STARTSWITH${prefix}`, 'name,parm1,parm2', 20);
  const policy = events.filter((e) => /not allowed as per Auth Policy/i.test(e.parm2));
  if (policy.length) {
    add('The instance refuses user name and password for these users',
      'An authentication policy blocked the login - the password was never checked, even though the page says "User name or password invalid". With Multi-Provider SSO on and account recovery on (glide.sso.acr.enabled = true), only accounts enrolled in account recovery may use the login page. Use Mock SSO for this test. (On an instance where the login page must work beside SSO, its administrator turns account recovery off; this app never changes that.)',
      policy.map((e) => `${e.name}: ${e.parm1} - ${e.parm2}`));
  } else if (events.some((e) => e.name === 'login.failed')) {
    add('ServiceNow counted failed logins for the test users', 'The password was checked and refused. If this is a Local sign-in test, the instance may have changed the password rules; run the test again.', events.filter((e) => e.name === 'login.failed').map((e) => `${e.name}: ${e.parm1}`));
  }

  // 3. API calls answered 401.
  if (sc.type === 'api' && seen(/HTTP 401/)) {
    const gate = await q('syslog', `${since}^messageLIKEdenied basic-auth API call^messageLIKE${prefix}`, 'message', 5);
    if (gate.length) {
      add('The instance restricts basic authentication for these users',
        'ServiceNow refused the API call before checking the password. Test users need the role snc_basic_auth_api_access and must be web-service-only accounts; this app sets both when the role exists. If the role was renamed on this instance, add the right role name under Test users > Roles, or use OAuth for this test.',
        gate.map((g) => String(g.message).slice(0, 200)));
    } else if (sc.authMode === 'oauth') {
      add('The OAuth token was refused', 'ServiceNow did not issue or accept a token. The password grant may be switched off or restricted to approved clients on this instance. Use basic authentication for this test, or ask the instance administrator.', []);
    } else {
      add('The API refused the test users (HTTP 401)', 'ServiceNow did not accept the user name and password. On an instance that enforces multi-factor authentication for everyone, an API user must be a web-service-only account (this app creates them that way). Check the System Log for "basic-auth" around the time of the run.', []);
    }
  }
  if (sc.type === 'api' && seen(/HTTP 403/)) add('The API refused the request for lack of rights (HTTP 403)', 'The test users signed in, but may not read or write what the request asks for. Give them the role that table or API needs under Test users > Roles (for most ITSM tables: itil).', errors.filter((e) => /403/.test(e)));
  if (sc.type === 'api' && seen(/HTTP 429/)) add('ServiceNow is rate-limiting the test users (HTTP 429)', 'A REST rate limit rule on the instance is answering instead of the API. This is a limit set by configuration, not a capacity limit of the instance. Lower the request rate (more pause between requests) or have the rule relaxed for the test.', []);

  // 4. The page loaded, but only to say no. For a knowledge article, say who may read it.
  if (sc.type !== 'api' && seen(/sufficient privileges|Security constraints|Not Authorized|Access Denied/i)) {
    const article = (sc.steps.map((s) => (s.url || '').match(/sysparm_article=(KB\d+)/i)).find(Boolean) || [])[1];
    let detail = 'The page opened but told the test users they may not see it. Give the temporary users the role or group a real reader has, under Test users.';
    const evidence = [];
    if (article) {
      const kb = await q('kb_knowledge', `number=${article}`, 'kb_knowledge_base,workflow_state', 1);
      if (kb.length) {
        const crit = await q('kb_uc_can_read_mtom', `kb_knowledge_base=${kb[0].kb_knowledge_base}`, 'user_criteria', 20);
        const ids = crit.map((c) => c.user_criteria).filter(Boolean);
        const rules = ids.length ? await q('user_criteria', `sys_idIN${ids.join(',')}`, 'name,group,role,company', 20, { display: true }) : [];
        if (kb[0].workflow_state !== 'published') evidence.push(`${article} is in state "${kb[0].workflow_state}", not published.`);
        for (const r of rules) evidence.push(`"${r.name}": ${[r.group && `groups ${r.group}`, r.role && `roles ${r.role}`, r.company && `companies ${String(r.company).slice(0, 80)}`].filter(Boolean).join('; ') || 'other conditions'}`);
        if (rules.length) detail = `The knowledge base of ${article} can be read only by users who match one of the rules below. Put one of those groups or roles under Test users (a group is the easiest).`;
        else if (!ids.length) detail = `The knowledge base of ${article} names no readers, and this instance blocks access when none are named. Give the test users a role that may read it (for example knowledge or itil).`;
      }
    }
    add('The test users are not allowed to see the page', detail, evidence);
  }

  // 5. The page never finished, or the selector never appeared.
  if (seen(/was not found on the page/)) add('The page loaded but the expected content did not appear', 'The "done when this appears" text or selector was not on the page. Open the screenshot of the step: if the page is right, correct the text; if it shows something else, that is the real answer.', errors.filter((e) => /was not found/.test(e)));
  if (seen(/still loading after the time limit|Timeout \d+ms exceeded|no answer within the time limit/)) {
    add(run.generatorBusy || (run.stages || []).some((s) => s.busy) ? 'Steps ran out of time while the test machine was at full CPU' : 'Steps ran out of time',
      run.generatorBusy || (run.stages || []).some((s) => s.busy)
        ? 'The machine driving the browsers was saturated, so these timeouts say nothing about ServiceNow. Lower the number of users, or add workers on other machines (Capacity and workers).'
        : 'ServiceNow did not finish answering within the step time limit. If this happens with one user, raise the limit or check the instance is awake; if only under load, this is the limit you are looking for.',
      errors.filter((e) => /time limit|Timeout/.test(e)));
  }
  if (seen(/not signed in|landed on/) && !out.length) add('The test users were not signed in', 'The browser ended on the login page. If the instance sends everyone to a company sign-on page first, Local sign-in cannot work: use Mock SSO.', errors.filter((e) => /not signed in|landed on/.test(e)));
  return out;
}

module.exports = { diagnose, connectionHints };
