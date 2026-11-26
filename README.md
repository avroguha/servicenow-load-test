# ServiceNow Load Test

A web app for finding out how a ServiceNow page or API behaves as more people
use it at the same time. People sign in, describe a test ("go to this URL"),
try it once, then put load on it and watch what happens and how fast.

- **Two kinds of test.** *Browser (UI)*: real browsers (Playwright) open pages
  the way people do, with single sign-on. *API*: plain HTTP requests to REST
  endpoints, with basic authentication or an OAuth token.
- **The app makes its own test users** on ServiceNow, with the roles and groups
  you name, and whatever the sign-in method needs (an identity provider record
  for Mock SSO, a temporary OAuth client for OAuth). It removes all of it when
  the run ends.
- **Three ways to apply load.** *Find the limit* (add users step by step),
  *Sustained* (a steady number for a set time), *Parallel* (everyone starts in
  the same instant).
- **A Test button** on every test: one temporary user goes through the steps
  once, with a screenshot (UI) or the answer (API) for each step.
- **It explains failures itself.** After a run with failures the app looks on
  the instance for the reason and says what to do.
- **Several instances, several proxies.** Each test chooses its instance and,
  if needed, the proxy to reach it through.

## Start

```
npm ci
npm run deps:check      # the 72-hour gate: refuses any package published less than 72 h ago
npm start               # http://127.0.0.1:8787  - sign in admin / admin
```

Needs Node 20+ and a browser for UI tests: Google Chrome or Edge already
installed, or Playwright's own Chromium (`npx playwright-core install
chromium`). `UILOAD_PORT`, `UILOAD_HOST` (default `127.0.0.1`) and `UILOAD_DATA`
(default `./data`) change the defaults.

Home lab: `bash deploy/lab/redeploy.sh` installs it on `avro@192.168.5.46` as a
systemd service (`uiload`), without Docker; the app is then at
`http://192.168.5.46:8787`.

## The menu

| | |
|---|---|
| **Overview** | what is running, recent runs, anything still on an instance |
| **Tests > All tests / New test** | the tests and the editor |
| **Runs > Live run** | the run in progress: phase, speed, what each user is doing, results |
| **Runs > History** | every past run with its results and screenshots |
| **ServiceNow > Instances** | the instances, their admin credentials and proxies (administrators) |
| **ServiceNow > Records on the instance** | everything the app created on ServiceNow, run by run, and whether it is gone |
| **Administration > Capacity and workers** | how many browsers / API users this machine may drive; extra workers |
| **Administration > People** | who can sign in: testers and administrators |
| **My account** | change your password |

## Making a test

1. **What to test** - a name, the instance, the proxy if any, Browser or API.
2. **Steps** - Browser: open a link, click, type, wait. API: requests (method,
   URL, JSON body) and waits. A URL can be a path; it is added to the
   instance's address. For a link, "done when this appears" (`text=Some words`
   or a CSS selector) makes sure the right page was reached.
3. **Test users** - sign-in method, the name they start with (`lt.user.` gives
   `lt.user.001`, ...), roles and groups.
4. **Load** - the pattern and its numbers, how long a user stays on a page.
5. **When is it too slow** - the line that marks "the limit".

**Save**, then **Test (1 user, once)**. When that is green, **Run load test**.

### A link from an email

Someone clicks a link in an email: they arrive with no session, go through
SSO, and land on the page. Use sign-in *Mock SSO*, **Arrival** = *Click the
first link with no session*, **Session** = *Arrive fresh for every pass*. The
step's time then covers the whole arrival. Repeat arrivals keep the browser
cache, as a returning reader's browser does.

## What it creates on ServiceNow, and removes

| Sign-in | Created for the run |
|---|---|
| all | `sys_user` records (title `UI load test [run <id>]`), their role and group memberships |
| Mock SSO | one certificate, one identity provider record, the link between them |
| User name and password | nothing more (the users get a random password) |
| API, basic authentication | nothing more; the users are web-service-only accounts and get `snc_basic_auth_api_access` when the instance has that role |
| API, OAuth | one OAuth client; its tokens |

- Checks run first: a failed check stops the run with nothing created. A user
  name that already exists is such a failure - existing users are never touched.
- The run removes everything when it ends, then searches the instance again to
  confirm.
- **Nothing stays longer than two hours.** A run still going after two hours
  (paused, forgotten) is stopped and cleaned. A cleanup that could not finish
  (the instance was away) is retried every five minutes, and at start-up for a
  run the app was closed in the middle of.
- **Records on the instance** shows all of this per run, with *Clean up now*.

The app never changes a system property, a plugin, or a record it did not
create.

### Mock SSO: only the test users get it

- The identity provider record is not the default, not on the login page,
  auto-provisioning off. ServiceNow sends a browser to it only for a user whose
  `sso_source` names it - the temporary users.
- Its signing key is made for each run, kept in memory, never written down; the
  certificate is removed from the instance when the run ends.
- The mock sign-in answers only a browser carrying a ticket for one of the
  run's users, and only towards the instance under test.
- The exchange goes through the browser, so the instance never has to reach
  this app.
- Needs Multi-Provider SSO switched on (it is, on any instance that uses SSO).

## What the app works out by itself

After a run with failed steps the app reads the instance and shows *Why steps
failed, and what to do*:

| What happened | Where the app looks | What it says |
|---|---|---|
| "You do not have sufficient privileges" on a knowledge article | the article's knowledge base and its read rules | which groups, roles or companies may read it |
| the login page says "User name or password invalid" | the event log (`ifl.authentication.failed`) | an authentication policy refused the user; use Mock SSO |
| SSO sign-in bounced | the system log, source `SAML2` | the logged reason, in words |
| API answers 401 | the system log (basic-auth gate) | the role and account type an API user needs |
| API answers 403 / 429 | the errors themselves | missing role / a rate limit rule |
| steps time out while workers are at full CPU | the workers | the test machine was the limit, not ServiceNow |

A page that loads fine but only shows a refusal is counted as a failed step,
at once, with the page's own message. When an instance's admin connection is
refused, the Instances page lists the causes to check, most likely first.

## Capacity: reading results honestly

- A real browser on a ServiceNow page takes a good part of a CPU core. The app
  works out a limit from the machine (about 2.5 browsers per core, 0.4 GB each)
  and refuses a browser test above it; an administrator can change it. When a
  worker reaches 90% CPU the run says so and marks that stretch: the slowdown
  may be the test machine.
- API users are light: hundreds from one machine (default limit 2000).
- For more browsers, add workers on other machines (Capacity and workers shows
  the command).
- A step is timed until the page has had no request in flight for 0.7 s
  (long-lived channels are ignored) - closer to "the page is usable" than the
  browser's load event.
- A brand-new user's first sign-in is slower than a returning user's.

## Tests

```
npm test
```

35 tests, no network: the SAML signature (also checked once against
`xmlsec1`), the mock sign-in's refusals, checks / creation / cleanup against an
in-memory instance for every sign-in method, load patterns, limits, the
two-hour rule, the proxy tunnel, the diagnosis rules, several instances, and
the supply-chain gate. Every path above was also run against a developer
instance on the Brazil release.

## Layout

```
src/server.js     web app: accounts, API, workers' endpoint, /idp/* (mock sign-in)
src/run.js        a run from checks to cleanup; patterns, limits, the two-hour rule, the janitor
src/worker.js     browser users and API users; reports timings, screenshots, what each user is doing
src/provision.js  what is created on the instance and how it is removed
src/diagnose.js   why steps failed, read from the instance
src/http.js       requests, directly or through a proxy
src/sn.js         the REST client for one instance
src/saml.js, x509.js, idp.js   the mock single sign-on
public/           the page
deploy/lab/       install on the home-lab container
```
