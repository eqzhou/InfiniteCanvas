#!/bin/sh
set -eu

api_pid=""
nginx_pid=""

stop() {
  if [ -n "$nginx_pid" ]; then
    kill -TERM "$nginx_pid" 2>/dev/null || true
    wait "$nginx_pid" 2>/dev/null || true
  fi
  if [ -n "$api_pid" ]; then
    kill -TERM "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
}

trap stop EXIT HUP INT TERM

case "${OPENBOARD_TOKEN:-}" in
  *[!A-Za-z0-9._~+-]*)
    echo "OPENBOARD_TOKEN may contain only URL-safe token characters" >&2
    exit 1
    ;;
esac

mkdir -p \
  /tmp/openboard \
  /tmp/nginx/client_temp \
  /tmp/nginx/proxy_temp \
  /tmp/nginx/fastcgi_temp \
  /tmp/nginx/uwsgi_temp \
  /tmp/nginx/scgi_temp

# A graceful render removes its own directory. Remove only server-named stale
# render directories left by a prior container crash; unrelated media stays.
if [ -d /data/film-render ]; then
  find /data/film-render -mindepth 1 -maxdepth 1 -type d \
    \( -name 'render-*' -o -name 'timeline-*' \) \
    -exec rm -rf -- {} \;
fi

envsubst '${OPENBOARD_TOKEN}' \
  < /etc/nginx/nginx.conf \
  > /tmp/nginx/nginx.conf

/usr/local/bin/openboard-server &
api_pid=$!

attempt=0
api_health() {
  if [ -n "${OPENBOARD_TOKEN:-}" ]; then
    wget -q -T 1 \
      --header "Authorization: Bearer ${OPENBOARD_TOKEN}" \
      -O /dev/null "http://${OPENBOARD_ADDR:-127.0.0.1:8790}/api/health"
  else
    wget -q -T 1 -O /dev/null \
      "http://${OPENBOARD_ADDR:-127.0.0.1:8790}/api/health"
  fi
}

until api_health; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    wait "$api_pid"
    exit $?
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "OpenBoard API did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

nginx -c /tmp/nginx/nginx.conf -g 'daemon off;' &
nginx_pid=$!

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$nginx_pid" 2>/dev/null; do
  sleep 1
done

status=0
if ! kill -0 "$api_pid" 2>/dev/null; then
  wait "$api_pid" || status=$?
  echo "OpenBoard API exited with status $status" >&2
else
  wait "$nginx_pid" || status=$?
  echo "OpenBoard web server exited with status $status" >&2
fi
exit "$status"
