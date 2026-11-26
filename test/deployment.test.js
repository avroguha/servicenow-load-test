'use strict';
// The deployment files, read as text. These are the rules that break a build
// at the office (or at home) without any application test noticing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const envOf = (f) => Object.fromEntries(read(f).split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const work = envOf('work.env');
const home = envOf('home.env');
const PUBLIC = /registry\.npmjs\.org|pypi\.org|docker\.io|quay\.io|ghcr\.io|mcr\.microsoft\.com|nodejs\.org|cdn\.playwright\.dev/;

test('no site location is written into the image build or the compose file', () => {
  for (const [name, text] of [['Dockerfile', dockerfile], ['docker-compose.yml', compose]]) assert.ok(!PUBLIC.test(text), `${name} names a public registry`);
  for (const arg of ['IMAGE_REGISTRY', 'IMAGE_PLAYWRIGHT', 'NPM_REGISTRY', 'NPM_TOKEN', 'CA_BUNDLE_B64', 'HTTP_PROXY', 'HTTPS_PROXY']) assert.match(dockerfile, new RegExp(`^ARG ${arg}=$`, 'm'), `${arg} must default to empty`);
  assert.match(dockerfile, /^ARG NO_PROXY=localhost,127\.0\.0\.1$/m);
  assert.match(dockerfile, /\$\{NPM_REGISTRY:\?[^}]+env file/, 'a build without an env file stops with a message');
});

test('the base image: path from the env file, tag and digest pinned once in the Dockerfile, more than 72 hours old', () => {
  const m = dockerfile.match(/^FROM \$\{IMAGE_PLAYWRIGHT\}:([\w.-]+)@(sha256:[0-9a-f]{64})$/m);
  assert.ok(m, 'FROM must take the path from IMAGE_PLAYWRIGHT and carry a tag and a digest');
  assert.ok(!/[:@]/.test(work.IMAGE_PLAYWRIGHT) && !/[:@]/.test(home.IMAGE_PLAYWRIGHT), 'the env files give the path only; the pin lives in the Dockerfile');
  assert.match(work.IMAGE_PLAYWRIGHT.split('/')[0], /(^|\.)avro\.com$/, 'work.env must pull the image from the site registry');
  const pin = JSON.parse(read('image-pins.json')).find((p) => p.digest === m[2]);
  assert.ok(pin, 'the digest in the Dockerfile is not recorded in image-pins.json');
  assert.strictEqual(pin.tag, m[1]);
  assert.ok(Date.now() - Date.parse(pin.created) > 72 * 3600e3, 'the pinned image is younger than 72 hours');
  // The image carries the browser build that the locked playwright-core expects.
  const core = JSON.parse(read('package-lock.json')).packages['node_modules/playwright-core'].version;
  assert.strictEqual(m[1], `v${core}-noble`);
});

test('compose requires every location from the env file, and both env files set them all', () => {
  const vars = [...compose.matchAll(/\$\{(\w+)([^}]*)\}/g)].map((x) => ({ name: x[1], rest: x[2] }));
  assert.ok(vars.length >= 10);
  for (const v of vars) {
    if (v.name === 'NPM_TOKEN') { assert.strictEqual(v.rest, '-', 'the token is optional and empty by default'); continue; }
    assert.match(v.rest, /^\?.+/, `${v.name} must be required with a message (\${${v.name}?...}), not defaulted`);
    assert.ok(v.name in work, `work.env does not set ${v.name}`);
    assert.ok(v.name in home, `home.env does not set ${v.name}`);
  }
  assert.ok(!/\$\{\w+:-/.test(compose), 'the ${VAR:-default} form replaces an explicitly empty value');
  assert.deepStrictEqual(Object.keys(work).sort(), Object.keys(home).sort(), 'the two env files must hold the same keys');
});

test('every build argument the Dockerfile takes is passed by compose, the token included', () => {
  for (const arg of [...dockerfile.matchAll(/^ARG (\w+)=/gm)].map((x) => x[1])) assert.match(compose, new RegExp(`^\\s+${arg}: \\$\\{${arg}[?-]`, 'm'), `compose does not pass ${arg} to the build`);
  for (const svc of ['init', 'app']) {
    const block = compose.slice(compose.indexOf(`\n  ${svc}:`));
    assert.match(block.slice(0, 400), /build: \*build\n\s+pull_policy: build/, `${svc} must build the image here, never pull it`);
  }
});

test('the env files: placeholders at work, public and no proxy at home, no secret in either', () => {
  for (const k of ['IMAGE_REGISTRY', 'IMAGE_PLAYWRIGHT', 'NPM_REGISTRY', 'HTTP_PROXY', 'HTTPS_PROXY', 'PUBLIC_HOST']) assert.match(work[k], /avro\.com/, `work.env ${k} must be an avro.com placeholder`);
  assert.match(work.IMAGE_REGISTRY, /^[\w.-]*avro\.com\/$/, 'the registry prefix ends with a slash');
  assert.strictEqual(home.IMAGE_REGISTRY, '');
  assert.match(new URL(work.NPM_REGISTRY).hostname, /(^|\.)avro\.com$/);
  assert.strictEqual(home.HTTP_PROXY, ''); assert.strictEqual(home.HTTPS_PROXY, ''); assert.strictEqual(home.CA_BUNDLE_B64, ''); assert.strictEqual(work.CA_BUNDLE_B64, '', 'an optional input defaults to empty');
  for (const env of [work, home]) for (const [k, v] of Object.entries(env)) assert.ok(!(/TOKEN|PASSWORD|SECRET|KEY/.test(k) && v), `${k} holds a value in an env file`);
});

test('nothing of the build site ships in the image, and it does not run as root', () => {
  assert.ok(!/^ENV .*(HTTP_PROXY|NPM_TOKEN|NPM_REGISTRY)=\S/m.test(dockerfile), 'a proxy, registry or token is set with ENV');
  const env = dockerfile.match(/^ENV [\s\S]*?(?=\n\n|\nEXPOSE)/m)[0];
  for (const k of ['NPM_TOKEN', 'NPM_REGISTRY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) assert.match(env, new RegExp(`\\b${k}= `), `${k} is not cleared in the final image`);
  assert.match(dockerfile, /rm -rf \/root\/\.npmrc/, 'the npm settings (registry, token) are removed in the step that used them');
  assert.match(dockerfile, /^USER app$/m);
  assert.ok(dockerfile.indexOf('USER app') > dockerfile.indexOf('npm ci'));
  // Ubuntu 24.04 already has a user with uid 1000: without removing it the build fails, or the app gets another id and cannot write its state.
  assert.match(dockerfile, /userdel -r ubuntu[^\n]*\n\s+groupadd -g 1000 app && useradd -u 1000 -g 1000/);
  assert.match(compose, /chown -R 1000:1000 \/state/);
});

test('packages are installed from the lock file and pass the 72-hour gate, offline', () => {
  assert.match(dockerfile, /npm ci --omit=dev[^;]*; \\\n\s+node scripts\/check-release-age\.js --offline;/);
  assert.ok(!/npm install\b/.test(dockerfile));
});

test('the legacy builder can build it', () => {
  assert.ok(!/^# syntax=|RUN --mount|COPY --(chmod|link)|<<-?['"]?EOF/m.test(dockerfile), 'BuildKit-only syntax');
});

test('the health check does not start a language runtime', () => {
  const hc = dockerfile.match(/^HEALTHCHECK .*$/m)[0];
  assert.match(hc, /CMD curl /); assert.ok(!/node|python/.test(hc));
});

test('HTTPS: published ports instead of host networking, with the reason written down; state on a bind mount with a chown step', () => {
  assert.match(compose, /\$\{HTTPS_PORT\?[^}]+\}:8443/); assert.match(compose, /\$\{HTTP_PORT\?[^}]+\}:8081/);
  assert.ok(!/^\s*network_mode: host/m.test(compose));
  assert.match(compose, /cannot bind 443 or 80 itself/);
  assert.match(compose, /\$\{STATE_DIR\?[^}]+\}:\/state/);
  assert.match(compose, /chown -R 1000:1000 \/state/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.ok(!/container_name:/.test(compose));
  const server = read('src/server.js');
  assert.match(server, /Refusing to serve plain HTTP on a network address/, 'plain HTTP off loopback needs an explicit setting');
  assert.match(server, /server\.listen\(PORT, '127\.0\.0\.1'\)/, 'with HTTPS on, the plain port stays on loopback');
});

test('what must not be committed is ignored, what must be committed is not, and no source file is ignored', () => {
  const gi = read('.gitignore');
  for (const rule of ['/data/', '/state/', '/certs/', '*.key', '*.pem', '*.pfx']) assert.ok(gi.split(/\r?\n/).includes(rule), `.gitignore lacks ${rule}`);
  for (const line of gi.split(/\r?\n/)) assert.ok(!/^(data|state|certs|secrets|config)\/$/.test(line), `"${line}" is not anchored: it would also ignore a source folder of that name`);
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) { const p = dir ? `${dir}/${e.name}` : e.name; if (e.isDirectory()) { if (!['node_modules', '.git', 'data', 'state'].includes(e.name)) walk(p); } else files.push(p); } };
  for (const d of ['src', 'public', 'scripts', 'test']) walk(d);
  files.push('work.env', 'home.env', 'Dockerfile', 'docker-compose.yml', 'image-pins.json', 'package-lock.json', 'deps-publish-times.json');
  let ignored = '';
  try { ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, input: Buffer.from(files.join('\n')) }).toString(); } catch (err) { if (err.status !== 1) throw err; }
  assert.strictEqual(ignored.trim(), '', 'these files would be missing from a clone and from the image');
  assert.match(read('.gitattributes'), /\*\.sh text eol=lf/, 'a shell script with Windows line endings does not run on Linux');
  assert.match(read('.dockerignore'), /^node_modules$/m);
});

test('the certificate script never shows the password and has its own test', () => {
  const s = read('scripts/install-cert.sh');
  assert.match(s, /read -r -s -p/); assert.match(s, /-passin env:UILOAD_CERT_PASSWORD/);
  assert.ok(!/-passin pass:/.test(s), 'a password on a command line is visible in the process list');
  assert.match(s, /-checkip/); assert.match(s, /-checkhost/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'test-install-cert.sh')));
});
