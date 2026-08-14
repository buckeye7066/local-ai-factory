#!/data/data/com.termux/files/usr/bin/bash
# ---------------------------------------------------------------------------
# engine.sh — start / stop / inspect the Factory Deck backend on the phone.
#
# The backend binds LOOPBACK ONLY (its own default). That is deliberate: the
# console lives on the same device, so nothing needs to cross the network, and
# a phone on a cafe Wi-Fi never exposes run history to the LAN.
#
#   factory-engine start|stop|restart|status|logs
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${FACTORY_APP_DIR:-$HOME/phone-console/local-ai-factory}"
RUN_DIR="$HOME/.phone-console"
PID_FILE="$RUN_DIR/factory-deck.pid"
LOG_FILE="$RUN_DIR/factory-deck.log"
PORT="${PORT:-5179}"

mkdir -p "$RUN_DIR"

alive() {
  [ -f "$PID_FILE" ] || return 1
  kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# Health is asked of the SERVER, not of the pid file. A live pid whose HTTP
# port never came up is a hang, and reporting that as "running" is the lie this
# function exists to prevent.
health() {
  curl -fsS --max-time 4 "http://127.0.0.1:$PORT/api/health" 2>/dev/null
}

cmd_start() {
  if alive && health >/dev/null; then
    echo "already running (pid $(cat "$PID_FILE")) and answering on :$PORT"
    return 0
  fi
  [ -d "$APP_DIR" ] || { echo "not installed: $APP_DIR — run setup.sh first" >&2; exit 1; }
  [ -f "$APP_DIR/.env" ] || { echo "no .env in $APP_DIR — copy scripts/phone/phone.env.example and add a key" >&2; exit 1; }
  [ -f "$APP_DIR/dist/ui/index.html" ] || { echo "no UI bundle in $APP_DIR/dist/ui — re-run setup.sh" >&2; exit 1; }

  # A wake lock is not optional. Android freezes background processes, and a
  # frozen orchestrator mid-run looks identical to a wedged one.
  command -v termux-wake-lock >/dev/null && termux-wake-lock || true

  cd "$APP_DIR"
  echo "--- $(date -Iseconds) starting ---" >> "$LOG_FILE"
  nohup env PORT="$PORT" node --import tsx src/server/index.ts >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  for _ in $(seq 1 40); do
    sleep 1
    if health >/dev/null; then
      echo "started (pid $(cat "$PID_FILE")) — http://127.0.0.1:$PORT/"
      return 0
    fi
    alive || { echo "process exited during startup; last log lines:" >&2; tail -n 25 "$LOG_FILE" >&2; exit 1; }
  done
  echo "started but never answered /api/health within 40s — treating as FAILED" >&2
  tail -n 25 "$LOG_FILE" >&2
  exit 1
}

cmd_stop() {
  if ! [ -f "$PID_FILE" ]; then echo "not running"; return 0; fi
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  command -v termux-wake-unlock >/dev/null && termux-wake-unlock || true
  echo "stopped"
}

cmd_status() {
  if alive; then echo "pid: $(cat "$PID_FILE") (alive)"; else echo "pid: none"; fi
  if h="$(health)"; then echo "http: OK on 127.0.0.1:$PORT"; echo "$h"; else
    echo "http: NOT ANSWERING on 127.0.0.1:$PORT"; exit 1; fi
}

case "${1:-status}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  logs)    tail -n "${2:-80}" "$LOG_FILE" ;;
  *)       echo "usage: factory-engine start|stop|restart|status|logs [n]" >&2; exit 2 ;;
esac
