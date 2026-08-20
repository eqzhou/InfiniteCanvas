#!/bin/sh
set -eu

if [ "$#" -eq 1 ] && [ "$1" = "--self-test" ]; then
  exec /usr/bin/bwrap \
    --unshare-user \
    --unshare-ipc \
    --unshare-pid \
    --unshare-net \
    --unshare-uts \
    --unshare-cgroup-try \
    --die-with-parent \
    --new-session \
    --clearenv \
    --cap-drop ALL \
    --ro-bind /usr /usr \
    --ro-bind-try /lib /lib \
    --ro-bind-try /usr/lib /usr/lib \
    --dir /proc \
    --dev /dev \
    --tmpfs /tmp \
    -- /usr/bin/pdftotext -v
fi

if [ "$#" -ne 7 ] || [ "$1" != "/usr/bin/pdftotext" ] || [ "$2" != "-layout" ] || \
  [ "$3" != "-enc" ] || [ "$4" != "UTF-8" ] || [ "$5" != "-nopgbrk" ] || [ "$7" != "-" ]; then
  echo "invalid PDF sandbox invocation" >&2
  exit 64
fi

input_path=$6
case "$input_path" in
  /data/film-import-tmp/pdf-*/input.pdf) ;;
  *) echo "invalid PDF sandbox input path" >&2; exit 64 ;;
esac
input_dir=${input_path%/input.pdf}

# Bound damage from malformed parser inputs before entering isolated namespaces.
ulimit -t 60
ulimit -f 4096
ulimit -n 64
ulimit -v 524288
ulimit -u 16

exec /usr/bin/bwrap \
  --unshare-user \
  --unshare-ipc \
  --unshare-pid \
  --unshare-net \
  --unshare-uts \
  --unshare-cgroup-try \
  --die-with-parent \
  --new-session \
  --clearenv \
  --cap-drop ALL \
  --ro-bind /usr /usr \
  --ro-bind-try /lib /lib \
  --ro-bind-try /usr/lib /usr/lib \
  --dir /etc \
  --ro-bind-try /etc/fonts /etc/fonts \
  --ro-bind "$input_dir" /input \
  --dir /proc \
  --dev /dev \
  --tmpfs /tmp \
  --setenv HOME /tmp \
  --setenv LANG C.UTF-8 \
  --chdir /tmp \
  -- /usr/bin/pdftotext -layout -enc UTF-8 -nopgbrk /input/input.pdf -
