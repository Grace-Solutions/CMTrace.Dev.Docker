# syntax=docker/dockerfile:1.7

#---------------------------------------------------------------------
# Stage 1: assemble static assets
#   If src/ already contains the mirrored site (index.html + app.html),
#   use it as-is. Otherwise mirror the upstream PWA from cmtrace.dev so
#   the image is zero-touch reproducible from an empty checkout.
#---------------------------------------------------------------------
FROM alpine:3.20 AS assets

ARG UPSTREAM_BASE=https://cmtrace.dev

RUN apk add --no-cache wget ca-certificates

WORKDIR /staging
COPY src/ /staging/

RUN set -eu; \
    if [ -f /staging/index.html ] && [ -f /staging/app.html ]; then \
        echo "[assets] using pre-mirrored src/"; \
    else \
        echo "[assets] src/ is empty — mirroring from ${UPSTREAM_BASE}"; \
        wget --mirror --page-requisites --no-host-directories --no-parent \
             --restrict-file-names=unix --execute robots=off \
             --user-agent='Mozilla/5.0 cmtrace.dev offline mirror' \
             -P /staging/ \
             "${UPSTREAM_BASE}/" \
             "${UPSTREAM_BASE}/app.html" \
             "${UPSTREAM_BASE}/manifest.webmanifest" \
             "${UPSTREAM_BASE}/favicon.svg" \
             "${UPSTREAM_BASE}/icon.svg" \
             "${UPSTREAM_BASE}/robots.txt" \
             "${UPSTREAM_BASE}/sitemap.xml"; \
        rm -f '/staging/app.html?sample=1'; \
    fi; \
    test -f /staging/index.html && test -f /staging/app.html

#---------------------------------------------------------------------
# Stage 2: runtime image
#---------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine

LABEL org.opencontainers.image.title="CMTrace.Dev.Docker"
LABEL org.opencontainers.image.description="Self-hosted, offline-capable mirror of CMTrace.dev — a browser-based log viewer for ConfigMgr, SCCM and Intune."
LABEL org.opencontainers.image.source="https://github.com/Grace-Solutions/CMTrace.Dev.Docker"
LABEL org.opencontainers.image.licenses="GPL-3.0-or-later"
LABEL org.opencontainers.image.url="https://cmtrace.dev/"

COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx/mime-extra.types /etc/nginx/conf.d/mime-extra.types
COPY docker/nginx/entrypoint.sh /docker-entrypoint.d/01-cmtrace-entrypoint.sh

COPY --from=assets /staging/ /usr/share/nginx/html/

# Strip upstream entrypoint scripts that mutate /etc/nginx (sed -i) — they
# require write ownership of the config tree and break when the container
# runs as an arbitrary PUID:PGID. Our nginx config already has explicit
# IPv6 listen + worker_processes settings.
USER root
RUN chmod +x /docker-entrypoint.d/01-cmtrace-entrypoint.sh && \
    rm -f /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh \
          /docker-entrypoint.d/30-tune-worker-processes.sh
USER 101

EXPOSE 19847

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:19847/ || exit 1
