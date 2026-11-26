# The load test app: controller, mock sign-in and browser workers in one image.
#
# Built on Playwright's own image (Ubuntu 24.04 with Node and Chromium in it, at
# the version playwright-core in package-lock.json expects), so the build
# downloads no browser and installs no system package.
#
# No site location is written here: where the base image and the npm packages
# come from, and the proxy to reach them, arrive from the env file through
# docker-compose.yml (work.env at the office, home.env in the lab):
#
#     docker compose --env-file work.env up --build -d
#
# Works on the legacy builder: no BuildKit-only syntax.

# IMAGE_PLAYWRIGHT: where the Playwright image is pulled from - its registry
# path without the tag - from the env file. Required. The tag and digest are
# pinned here, once: a digest is the same at home and behind a mirror, only the
# path in front of it differs.
# IMAGE_REGISTRY: the site's prefix for Docker Hub images. This build pulls none;
# it is accepted so every project is configured the same way.
ARG IMAGE_REGISTRY=
ARG IMAGE_PLAYWRIGHT=
FROM ${IMAGE_PLAYWRIGHT}:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

# Build-time only. ARG, not ENV: none of these may live on in the image.
ARG NPM_REGISTRY=
ARG NPM_TOKEN=
ARG CA_BUNDLE_B64=
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=localhost,127.0.0.1

WORKDIR /app
COPY package.json package-lock.json deps-publish-times.json ./
COPY scripts/check-release-age.js scripts/check-release-age.js

# One step: configure npm for this site, install exactly the lock file, refuse
# anything published in the last 72 hours (from the committed publish-time
# record - no registry lookup), then remove every trace of the site settings.
RUN set -eu; \
    : "${NPM_REGISTRY:?NPM_REGISTRY is empty - build with an env file: docker compose --env-file work.env (or home.env) up --build -d}"; \
    export http_proxy="${HTTP_PROXY}" https_proxy="${HTTPS_PROXY}" no_proxy="${NO_PROXY}"; \
    npm config set registry "${NPM_REGISTRY}"; \
    if [ -n "${NPM_TOKEN}" ]; then npm config set "$(printf '%s' "${NPM_REGISTRY}" | sed -E 's#^https?:##')/:_authToken" "${NPM_TOKEN}"; fi; \
    if [ -n "${CA_BUNDLE_B64}" ]; then printf '%s' "${CA_BUNDLE_B64}" | base64 -d > /tmp/site-ca.pem; npm config set cafile /tmp/site-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/site-ca.pem; fi; \
    npm ci --omit=dev --no-audit --no-fund; \
    node scripts/check-release-age.js --offline; \
    rm -rf /root/.npmrc /root/.npm /tmp/site-ca.pem

COPY src ./src
COPY public ./public

# An unprivileged user with uid 1000 - the id the init step gives the state
# folder to and scripts/install-cert.sh gives the certificate to. Ubuntu 24.04
# ships a user "ubuntu" holding that id, so it goes first.
RUN userdel -r ubuntu 2>/dev/null || true; \
    groupadd -g 1000 app && useradd -u 1000 -g 1000 -m -s /usr/sbin/nologin app && \
    mkdir -p /state && chown -R app:app /state /app
USER app

# Nothing of the build site ships: these were ARGs and are empty here on purpose.
ENV NPM_TOKEN= NPM_REGISTRY= HTTP_PROXY= HTTPS_PROXY= NO_PROXY= http_proxy= https_proxy= no_proxy= \
    NODE_ENV=production \
    UILOAD_DATA=/state/data UILOAD_CERTS=/state/certs \
    UILOAD_PORT=8787 UILOAD_HTTPS_PORT=8443 UILOAD_REDIRECT_PORT=8081

EXPOSE 8443 8081
# curl, not node: a language runtime started every 30 s costs a second of CPU each time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/server.js"]
