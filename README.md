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

That is the way to try it on one machine. To run it for a team, see
**Deploying with Docker** below: HTTPS on 443, one command.

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

## Deploying with Docker

One command per place; the env file names everything that differs:

```
docker compose --env-file work.env up --build -d     # office
docker compose --env-file home.env up --build -d     # home lab
```

The app is then on **https://<PUBLIC_HOST>** (port 443; port 80 only redirects).
Sign in `admin` / `admin` and change the password.

### At the office: what to set in work.env

`work.env` in this repository holds placeholders. On the work machine put the
site's real values in, and keep that edit out of git
(`git update-index --skip-worktree work.env`).

| Key | What it is |
|---|---|
| `IMAGE_REGISTRY` | the site's registry prefix for Docker Hub images, with the trailing slash |
| `IMAGE_PLAYWRIGHT` | where the site's registry serves the Playwright image from, **without tag** (the Dockerfile pins tag and digest) |
| `NPM_REGISTRY` | the site's npm mirror |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | the proxy for the build |
| `CA_BUNDLE_B64` | empty, unless the proxy intercepts TLS: then `base64 -w0 site-ca.pem` |
| `STATE_DIR` | the folder that keeps settings, results and the certificate (default `../uiload-state`, beside the project, so replacing the code never touches it) |
| `PUBLIC_HOST` | the name people type in the browser |
| `TLS_NAMES` | more names for the first, self-signed certificate; may be empty |
| `HTTPS_PORT`, `HTTP_PORT` | 443 and 80 |

Every key must be present in the file, even when empty: a missing one stops
`docker compose` with a message naming it. A registry token is never written
down - give it for the one command:
`NPM_TOKEN=... docker compose --env-file work.env up --build -d`. The image is
built and used on that host; do not push an image built with a token to a
registry (build arguments stay readable in an image's history).

The build proxy is not the proxy tests use. How a **test** reaches a ServiceNow
instance is set in the app (ServiceNow > Instances > Proxies), per instance and
per test.

What the build does: pulls the pinned Playwright image (Ubuntu 24.04 with Node
and Chromium - no browser download, no system packages), runs `npm ci` against
the mirror, and refuses any package published in the last 72 hours using the
committed publish-time record (no registry lookup). It works on the legacy
builder; buildx is not needed.

### HTTPS and the certificate

- The app always serves HTTPS. On first start with no certificate it makes a
  self-signed one for `PUBLIC_HOST`, `TLS_NAMES`, localhost - browsers warn
  until a real one is installed.
- To install the company certificate: download it as a **PEM bundle** (private
  key with a password, plus the certificate chain) or a **PFX**, then

  ```
  bash scripts/install-cert.sh my-download.pfx --host loadtest.avro.com
  ```

  It asks for the key's password (not echoed, never on a command line), finds
  the server certificate by matching it to the key, orders the chain, leaves the
  root out, checks the name and the expiry, backs up the old pair, and puts
  `tls.crt` and `tls.key` into `STATE_DIR/certs`. **The app switches to the new
  certificate within a minute, without a restart.** If the new pair is unusable
  the old one keeps serving and the log says why.
- `bash scripts/test-install-cert.sh` tests that script against made-up
  certificates (run it on Linux).

### How it runs

- As an unprivileged user (uid 1000), all capabilities dropped. It cannot bind
  443 itself, so it listens on 8443 / 8081 and Docker publishes them - that is
  why it does not use host networking.
- A one-shot `init` step runs first on every `up`, as root with no network, and
  gives `STATE_DIR` to that user; a certificate copied in by someone else
  becomes readable that way.
- The plain-HTTP port (8787) stays inside the container: the app's own workers,
  the health check and the mock sign-in pages use it.
- `docker compose ... down` during a run stops the load and removes the run's
  records from ServiceNow first (up to 200 s).
- Without Docker, the app refuses to serve plain HTTP on a network address
  unless `UILOAD_CERTS` names a certificate folder (HTTPS) or
  `UILOAD_PLAIN_HTTP=1` says a TLS proxy stands in front.

### Updating, and moving between home and work

Move git, not folders: `git pull` (or a bundle) on the host, then the same
`docker compose ... up --build -d`. `STATE_DIR` is outside the code folder.
`bash scripts/push-to-host.sh user@host home.env` does copy-and-up for the lab.

## Tests

```
npm test
```

47 tests, no network: the SAML signature (also checked once against
`xmlsec1`), the mock sign-in's refusals, checks / creation / cleanup against an
in-memory instance for every sign-in method, load patterns, limits, the
two-hour rule, the proxy tunnel, the diagnosis rules, several instances, the
supply-chain gate, and the deployment files themselves (image pin, required
locations, nothing of the build site in the image, HTTPS rules). Every path above was also run against a developer
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
src/tls.js        the HTTPS certificate: self-signed at first start, reloaded when replaced
Dockerfile, docker-compose.yml, work.env, home.env, image-pins.json   the deployment
scripts/install-cert.sh, test-install-cert.sh, push-to-host.sh
```
