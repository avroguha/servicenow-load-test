# The load test app: controller, mock sign-in and browser workers in one image.
#
# Base: the official Node image from Docker Hub, so at the office it comes
# through the site's Docker registry prefix like any other image. The browser is
# the distribution's own Chromium package, from the apt mirror - nothing is
# fetched from a browser vendor's download site.
#
# No site location is written here: the registry prefix, the apt and npm
# mirrors and the proxy arrive from the env file through docker-compose.yml
# (work.env at the office, home.env in the lab):
#
#     docker compose --env-file work.env up --build -d
#
# Works on the legacy builder: no BuildKit-only syntax.

# IMAGE_REGISTRY: the site's registry prefix with its trailing slash (empty = Docker Hub).
# IMAGE_NODE: the image behind it, pinned by digest - a digest is the same at
# home and behind a mirror, only the prefix differs. Its push date is recorded
# in image-pins.json; move the pin only to an image more than 72 hours old.
ARG IMAGE_REGISTRY=
ARG IMAGE_NODE=node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
FROM ${IMAGE_REGISTRY}${IMAGE_NODE}

# Build-time only. ARG, not ENV: none of these may live on in the image.
ARG APT_MIRROR=
ARG NPM_REGISTRY=
ARG NPM_TOKEN=
ARG CA_BUNDLE_B64=
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=localhost,127.0.0.1

# The browser and what the health check needs. With a mirror named, the
# image's package source is pointed at it and the separate security-updates
# source is dropped: a site mirror serves the main archive only, and a source
# that cannot be reached stops the build. Without a mirror the image's sources
# are used as they are (through the proxy, when one is set).
RUN set -eu; \
    export http_proxy="${HTTP_PROXY}" https_proxy="${HTTPS_PROXY}" no_proxy="${NO_PROXY}"; \
    src=/etc/apt/sources.list.d/debian.sources; \
    if [ -n "${APT_MIRROR}" ]; then \
      awk -v RS= -v ORS='\n\n' '!/debian-security/' "$src" > "$src.tmp" && mv "$src.tmp" "$src"; \
      sed -i "s#https\?://deb.debian.org/debian/\?\$#${APT_MIRROR%/}#" "$src"; \
    fi; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    chromium --version

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

# The Node image's own unprivileged user, uid 1000 - the id the init step gives
# the state folder to and scripts/install-cert.sh gives the certificate to.
RUN mkdir -p /state && chown -R node:node /state /app
USER node

# Nothing of the build site ships: these were ARGs and are empty here on purpose.
# UILOAD_BROWSER_PATH: the workers drive this browser, whatever the app's setting says.
ENV NPM_TOKEN= NPM_REGISTRY= HTTP_PROXY= HTTPS_PROXY= NO_PROXY= http_proxy= https_proxy= no_proxy= \
    NODE_ENV=production \
    UILOAD_BROWSER_PATH=/usr/bin/chromium \
    UILOAD_DATA=/state/data UILOAD_CERTS=/state/certs \
    UILOAD_PORT=8787 UILOAD_HTTPS_PORT=8443 UILOAD_REDIRECT_PORT=8081

EXPOSE 8443 8081
# curl, not node: a language runtime started every 30 s costs a second of CPU each time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/server.js"]
