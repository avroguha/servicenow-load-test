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
- **Three questions, in plain words.** *Can it carry a steady load?* *Can it
  take everyone at once?* *How many at the same moment?* You give a number or
  two; the run ends with the answer in a sentence and a chart of when trouble
  began. An advanced setup gives every setting.
- **Thousands of users from one machine.** A real browser costs a good part of
  a CPU core. *Lightweight users* send the requests a browser made, each with
  its own sign-in and session, without opening a browser.
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

On Windows without Docker, `scriptsstart-windows.cmd` does the same and keeps
settings and results in `%USERPROFILE%sn-load-test-data`.

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
4. **Load** - *Simple*: one of three questions and a number or two (below).
   *Advanced*: the pattern and all its numbers.
5. **When is it too slow** - the line between "fine" and "trouble".

**Save**, then **Test (1 user, once)**. When that is green, **Run load test**.

### The three questions (simple setup)

| Question | You give | What runs | The answer |
|---|---|---|---|
| **Can it carry a steady load?** | people at the same time, minutes | that many people keep going through the steps for that long | "Yes, 200 people were carried for 30 minutes", or "No: trouble began after 12 minutes (95% of steps took up to 11 s)" |
| **Can it take everyone at once?** | people in the company, the minutes within which they arrive | the number that is there *at the same moment* is worked out (people x one visit's length / the minutes); people are added in 5 steps up to it, each arriving fresh; stops at the first trouble | "Yes, 60,000 people within 30 minutes were carried (1000 at the same moment)", or "No: it coped with about 24,000 of them" |
| **How many at the same moment?** | the most to try | starts at a tenth and adds a tenth at a time; stops at the first trouble | "About 250 people at the same moment. At 300 trouble began: ..." |

"One visit's length" comes from the last test run. "Trouble" is the line of
section 5: 95% of steps slower than so many seconds, or more than so many
percent failing, in two measurements in a row.

The result page puts the answer first, then *What happened over time*: how long
steps took, how many people were active, failed steps as red dots, and a red
line where trouble began.

For someone who stays signed in, the first arrival (signing in, loading every
file for the first time) is much slower than everything after it. It is shown
per step but does not decide the limit. Where every visit is an arrival (the
"everyone at once" question), it is exactly what is measured.

### Lightweight users: more people than this machine has browsers for

A browser test with more people than the machine can drive as real browsers
(about 2.5 per CPU core) runs with **lightweight users** instead - by itself in
the simple setup, or by choice in the advanced one ("Users are").

- **Test (1 user, once)** in a real browser *records* what each step asks the
  instance for. A passing test run keeps that recording; after changing a step,
  test again.
- In a load run each lightweight user **signs in for real** - ServiceNow builds
  its sign-in request, this app's identity provider answers, ServiceNow checks
  the answer and opens a session - and then sends the recorded requests with its
  own session, its own token and its own user record. ServiceNow gets the same
  requests as from a browser.
- A new visitor fetches the page's files (scripts, styles, images); a returning
  one does not, as with a browser's cache.
- **What it does not measure:** the browser itself - drawing the page and
  running its scripts. The times are how long ServiceNow took to answer. A test
  run with one browser shows the rest.
- A recorded request that carries something only the recording session had
  (other than the token, the user and the sign-in ids, which are swapped) may be
  answered differently; such a request shows up as a failed request of its step.
- The limit is "Most API users at once" under Capacity and workers (2000 unless
  changed). One temporary user is created on ServiceNow per lightweight user.

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

When ServiceNow refuses the Mock SSO identity provider record (it answers
"Error during insert" with no reason), the app finds out why: an existing
record with the same entity id, an account without the role, or - building the
record inactive and field by field - the exact field or the activation that is
refused. Where only the one-step insert is refused, the step-by-step record
is used and the run goes on.

A run never sits silent and always ends with a verdict:

- A test (one user, once) ends **PASSED** or **FAILED**, in those words. A run
  in which no step ran at all is a failure, with the place it stopped.
- A worker that cannot start a browser tries the other kinds first (the image's
  own, the one chosen in the app, Chromium, Chrome, Edge) and says which it
  used; if none starts, the run ends at once with the reasons.
- A user that stays on one thing far longer than a step may take is named in
  the log while it is happening. A one-user test gives up after its steps' time
  limits, not after a fixed ten minutes.
- A worker process that dies or complains is reported in the run's log.

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
- For more browsers, add workers on other machines (next section).

### Workers on other machines

A worker is the same image started as a worker. On the other machine:

```bash
# set the WORKER_* lines of the env file first (where the app is, how many browsers)
mkdir -p ../uiload-worker
printf '%s' '<worker token>' > ../uiload-worker/join     # Administration > Capacity and workers shows it
docker compose -f docker-compose.worker.yml --env-file work.env up --build -d
docker compose -f docker-compose.worker.yml --env-file work.env logs -f worker
```

Without Docker: Node.js and a browser on the machine, `npm ci`, then
`node src/worker.js --controller https://<app> --token-file join --capacity 10`.

- **Ports.** The worker only makes outgoing connections: to the app's HTTPS
  port (443) and to ServiceNow or the proxy. Nothing is opened towards the
  worker machine. Port 8787 is not used between machines.
- **The app's certificate.** The worker checks it. If it comes from an
  authority the image does not know (or is the app's own self-signed one), put
  that certificate or its authority as `ca.pem` into `WORKER_DIR` (without
  Docker: `--ca file`). `WORKER_ACCEPT_ANY_CERTIFICATE=1` (`--insecure`)
  accepts any certificate - the worker token then goes to whoever answers, so
  that is for a lab only.
- **Mock SSO.** ServiceNow sends a test browser to
  `http://127.0.0.1:8787/idp/sso` - an address on the browser's own machine.
  On the app's machine the app answers there; on a worker machine the worker
  does, and passes the request to the app over its own connection. So the
  record on the instance is the same wherever the browsers run, and nothing
  needs changing for a remote worker. If port 8787 is taken on a worker
  machine, set another one under Capacity and workers ("Address of this app as
  the workers' browsers see it", for example `http://127.0.0.1:8790`).
- **When it does not connect**, the worker says why, at once and every half
  minute (certificate not trusted, nothing answering, name not found, wrong
  token). A connected worker is listed under Capacity and workers.
- Raise "Most browsers at once" under Capacity and workers: the default is
  worked out from the app's own machine.
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
| `IMAGE_REGISTRY` | the site's Docker registry prefix, with the trailing slash. The base image is the official Node image from Docker Hub, pulled through it |
| `APT_MIRROR` | the site's mirror of the Debian package archive (the browser is installed from it). Empty = the image's own source, through the proxy |
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

What the build does, and where each thing comes from:

| Step | Source |
|---|---|
| base image: official `node` image, pinned by digest | Docker Hub, through `IMAGE_REGISTRY` |
| the browser: Debian's `chromium` package, plus fonts and curl | the Debian archive, through `APT_MIRROR` or the proxy |
| `npm ci` (one package, `playwright-core`) | `NPM_REGISTRY` |

Nothing is fetched from a browser vendor's download site, and no image comes
from a registry other than Docker Hub. After `npm ci` the build refuses any
package published in the last 72 hours, using the committed publish-time record
(no registry lookup). It works on the legacy builder; buildx is not needed.

The browser is the distribution's build (Chromium 156 at the time of writing),
driven by `playwright-core` through the image's `UILOAD_BROWSER_PATH`. It is a
few versions behind the build Playwright ships for itself; sign-in through SSO,
page loads, clicks and screenshots were run against it. The browser setting
under Capacity and workers has no effect in this image.

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

53 tests, no network: the SAML signature (also checked once against
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
src/replay.js     lightweight users: what is recorded from a browser and how it is sent again
src/worker.js     browser users, lightweight users and API users; reports timings, screenshots, what each user is doing
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
