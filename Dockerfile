# Mission Zero — one image for Docker and Podman, on Linux, macOS and Windows
# (amd64 and arm64). Everything it keeps lives in the /data volume.
#
#   docker run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
#   podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
#
# The first start prints the administrator's sign-in in the container log:
#   docker logs mission-zero

FROM docker.io/library/node:22-alpine

# Building behind a company proxy that inspects TLS? Pass its CA certificate:
#   docker build --secret id=ca,src=company-ca.pem -t mission-zero .
# (podman build takes the same flag). Without it, nothing changes.

# git: the Beta "code authors" feature reads repository history.
# tini: reaps git's child processes and passes stop signals on.
# tzdata: automatic reminders run in the time zone given by TZ.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then cat /run/secrets/ca >> /etc/ssl/certs/ca-certificates.crt; fi && \
    apk add --no-cache git tini tzdata ca-certificates

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi && \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# State (settings, users, credit ledger, audit log, backups) in one volume.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=UTC

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
