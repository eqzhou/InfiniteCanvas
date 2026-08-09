# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS web-build
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS server-build
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath -ldflags="-s -w" -o /openboard-server ./cmd/server

FROM nginx:1.30-alpine@sha256:0d3b80406a13a767339fbe2f41406d6c7da727ab89cf8fae399e81f780f814d1 AS runtime
# The digest-pinned base is Alpine 3.23. Install its signed repository package
# at an exact revision; do not fetch standalone media binaries.
RUN apk add --no-cache dumb-init gettext ffmpeg=8.0.1-r1 \
    && mkdir -p /data/film-render /tmp/openboard /tmp/nginx/client_temp \
    && chown -R nginx:nginx /data /tmp/openboard /tmp/nginx

COPY --from=web-build /src/web/dist /usr/share/nginx/html
COPY --from=server-build /openboard-server /usr/local/bin/openboard-server
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /usr/local/bin/openboard-entrypoint

RUN chmod 0555 /usr/local/bin/openboard-server /usr/local/bin/openboard-entrypoint \
    && chmod -R a=rX /usr/share/nginx/html /etc/nginx/nginx.conf

USER nginx
EXPOSE 8080
VOLUME ["/data"]

ENV OPENBOARD_ADDR=127.0.0.1:8790 \
    OPENBOARD_DATA=/data \
    OPENBOARD_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 \
    OPENBOARD_FFMPEG_PATH=/usr/bin/ffmpeg \
    OPENBOARD_FFPROBE_PATH=/usr/bin/ffprobe \
    TMPDIR=/tmp/openboard

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -T 2 -O /dev/null http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/usr/local/bin/openboard-entrypoint"]
