#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/.particle-rose.pid"

notify() {
  if command -v notify-send >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    notify-send "Particle Rose" "$1" >/dev/null 2>&1 || true
  fi
}

if [ ! -f "$PID_FILE" ]; then
  notify "Particle Rose is not managed by the launcher."
  exit 0
fi

PID="$(sed -n '1p' "$PID_FILE")"
if ! [[ "$PID" =~ ^[0-9]+$ ]]; then
  rm -f "$PID_FILE"
  notify "Particle Rose launcher state was reset."
  exit 0
fi

is_our_process() {
  [ -d "/proc/${PID}" ] || return 1
  [ "$(readlink -f "/proc/${PID}/cwd" 2>/dev/null || true)" = "$ROOT_DIR" ] || return 1
  tr '\0' ' ' <"/proc/${PID}/cmdline" 2>/dev/null | grep -Eq 'npm run dev|vite'
}

if kill -0 "$PID" 2>/dev/null && is_our_process; then
  # The start script creates a dedicated session, so this only targets its
  # Vite process group and leaves unrelated Node services untouched.
  kill -- "-$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 40); do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL -- "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
  fi
fi

rm -f "$PID_FILE"
notify "Particle Rose stopped."
