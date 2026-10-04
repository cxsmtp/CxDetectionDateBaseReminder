# CxMissionZero — one image for Docker and Podman, on Linux, macOS and Windows
# (amd64 and arm64). Everything it keeps lives in the /data volume.
#
#   docker run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
#   podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
#
# The first start prints the administrator's sign-in in the container log:
#   docker logs mission-zero

# Both stages start from plain Alpine and add Alpine's own Node.js packages, so
# no image carries the npm that official node images bundle (and its CVEs).
# Packages are pinned to their major line on this Alpine branch: fixes still
# arrive with each rebuild, a new major never does by surprise.

# ---- Dependencies: installed with npm here, and only node_modules moves on ----
FROM docker.io/library/alpine:3.24 AS deps

# Building behind a company proxy that inspects TLS? Pass its CA certificate:
#   docker build --secret id=ca,src=company-ca.pem -t mission-zero .
# (podman build takes the same flag). Without it, nothing changes.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then cat /run/secrets/ca >> /etc/ssl/certs/ca-certificates.crt; fi && \
    apk add --no-cache nodejs~=24 npm~=11
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi && \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- Runtime: Node.js without a package manager, runs as `node` (uid 1000) ----
FROM docker.io/library/alpine:3.24

# git: the Beta "code authors" feature reads repository history.
# tini: reaps git's child processes and passes stop signals on.
# Time zones (TZ) come from the ICU data Node.js ships with; no tzdata needed.
# `apk upgrade` takes the base image's OS packages to their latest fixes.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then cat /run/secrets/ca >> /etc/ssl/certs/ca-certificates.crt; fi && \
    apk upgrade --no-cache && \
    apk add --no-cache nodejs~=24 git~=2 tini~=0.19 && \
    addgroup -g 1000 -S node && adduser -u 1000 -S -G node -h /home/node node

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY LICENSE TERMS.md CHANGELOG.md ./
# The Node.js this image runs (# mz-runtime): an update from Settings that needs another one says so.
RUN node -p "process.versions.node" > .node-version # mz-runtime

# State (settings, users, credit ledger, audit log, backups) in one volume.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# HTTPS=on: a production release serves HTTPS by default (your certificate via TLS_CERT_FILE /
# TLS_KEY_FILE or TLS_PFX_FILE, else a self-signed one). -e HTTPS=off for plain http on a laptop,
# or behind a reverse proxy that does HTTPS (docs/https-and-hosting.md).
ENV NODE_ENV=production \
    HTTPS=on \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=UTC

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]

# The launcher runs the version chosen under Settings → Update & recovery (or this image's own),
# switches and rolls back without a container restart. `node src/server.js` still works on its own.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/launch.js"]
