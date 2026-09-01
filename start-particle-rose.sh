#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PARTICLE_ROSE_PORT:-5174}"
URL="http://localhost:${PORT}/"
PID_FILE="${ROOT_DIR}/.particle-rose.pid"
LOG_FILE="${ROOT_DIR}/.particle-rose.log"

notify() {
  if command -v notify-send >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    notify-send "Particle Rose" "$1" >/dev/null 2>&1 || true
  fi
}

open_browser() {
  if command -v google-chrome >/dev/null 2>&1; then
    google-chrome --new-window "$URL" >/dev/null 2>&1 &
  elif command -v google-chrome-stable >/dev/null 2>&1; then
    google-chrome-stable --new-window "$URL" >/dev/null 2>&1 &
  elif command -v chromium >/dev/null 2>&1; then
    chromium --new-window "$URL" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
  fi
}

is_project_page() {
  curl -fsS --max-time 1 "$URL" 2>/dev/null | grep -q '/src/main.tsx'
}

is_alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

is_our_process() {
  local pid="$1"
  [ -d "/proc/${pid}" ] || return 1
  [ "$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)" = "$ROOT_DIR" ] || return 1
  tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -Eq 'npm run dev|vite'
}

if [ -f "$PID_FILE" ]; then
  PID="$(sed -n '1p' "$PID_FILE")"
  if is_alive "$PID" && is_our_process "$PID"; then
    open_browser
    notify "Particle Rose is already running."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if is_project_page; then
  open_browser
  notify "Particle Rose is already running on port ${PORT}."
  exit 0
fi

if curl -sS --max-time 1 "$URL" >/dev/null 2>&1; then
  notify "Port ${PORT} is already in use by another service."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  notify "npm was not found. Install Node.js first."
  exit 1
fi

cd "$ROOT_DIR" || exit 1
setsid npm run dev -- --host 127.0.0.1 --port "$PORT" >"$LOG_FILE" 2>&1 < /dev/null &
PID=$!
printf '%s\n' "$PID" >"$PID_FILE"

for _ in $(seq 1 60); do
  if is_project_page; then
    open_browser
    notify "Particle Rose is ready."
    exit 0
  fi
  if ! is_alive "$PID"; then
    rm -f "$PID_FILE"
    notify "Particle Rose stopped during startup. Check .particle-rose.log."
    exit 1
  fi
  sleep 0.25
done

if is_alive "$PID"; then
  kill -- "-$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true
fi
rm -f "$PID_FILE"
notify "Particle Rose did not become ready. Check .particle-rose.log."
exit 1
