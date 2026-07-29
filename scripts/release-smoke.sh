#!/usr/bin/env bash
#
# release-smoke — pre-release confidence gate for codeoid's `main` branch.
#
# Runs everything CI runs (lint / typecheck / test / build for the daemon and
# the web app) PLUS the layers CI can't:
#
#   • version coherence — the built `codeoid --version` matches package.json,
#     and every publishable workspace package is in lockstep with it (guards
#     against the hand-synced version string drifting from the published
#     package, and against a partial `version:set`);
#   • daemon boot probe — the actual built bundle starts and binds its port
#     (catches runtime-boot breakage a `bun build` alone won't: bad dynamic
#     imports, top-level-await regressions, ESM path mistakes);
#   • real-backend journeys (opt-in) — the integration suites that self-skip in
#     CI: create → turn → reply, and cross-backend fork → resume/recall.
#
# The boot probe runs against a throwaway XDG_CONFIG_HOME, so it never touches
# your real ~/.codeoid state or a daemon you already have running.
#
# Usage:
#   bun run smoke                          # deterministic gates + daemon boot
#   CODEOID_SMOKE_INTEGRATION=1 bun run smoke   # + real-backend journeys
#
# Env:
#   CODEOID_SMOKE_INTEGRATION=1   opt in to the real-backend layer (needs an
#                                 authed backend; costs tokens).
#   CODEOID_SMOKE_BACKENDS=...    comma list for the backends suite
#                                 (default: claude). Multiple authed backends
#                                 also exercise the cross-backend fork-resume.
#   CODEOID_SMOKE_KEEP_GOING=1    run every stage even after a failure
#                                 (default: stop at the first failure).
#
# Exits non-zero if any stage FAILS. SKIPPED stages never fail the run.

set -uo pipefail

# Always operate from the repo root, regardless of invocation cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

KEEP_GOING="${CODEOID_SMOKE_KEEP_GOING:-0}"

# ── Result tracking ───────────────────────────────────────────────────────────
declare -a RESULTS=()
FAILED=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
gray()  { printf '\033[90m%s\033[0m' "$*"; }

record() { RESULTS+=("$1|$2"); } # name|PASS|FAIL|SKIP

# run_stage <name> <command...>
run_stage() {
  local name="$1"; shift
  bold "▶ $name"
  if "$@"; then
    printf '  %s %s\n\n' "$(green '✓ PASS')" "$name"
    record "$name" "PASS"
  else
    printf '  %s %s\n\n' "$(red '✗ FAIL')" "$name"
    record "$name" "FAIL"
    FAILED=1
    if [ "$KEEP_GOING" != "1" ]; then
      summary
      exit 1
    fi
  fi
}

skip_stage() {
  local name="$1" reason="$2"
  bold "▷ $name"
  printf '  %s %s — %s\n\n' "$(gray '· SKIP')" "$name" "$reason"
  record "$name" "SKIP"
}

summary() {
  echo
  bold "── release-smoke summary ──────────────────────────────"
  for r in "${RESULTS[@]}"; do
    local name="${r%%|*}" status="${r##*|}"
    case "$status" in
      PASS) printf '  %s  %s\n' "$(green 'PASS')" "$name" ;;
      FAIL) printf '  %s  %s\n' "$(red 'FAIL')" "$name" ;;
      SKIP) printf '  %s  %s\n' "$(gray 'SKIP')" "$name" ;;
    esac
  done
  echo
  if [ "$FAILED" = "1" ]; then
    red "release-smoke: FAILED"; echo
  else
    green "release-smoke: OK"; echo
  fi
}

# ── Preflight ─────────────────────────────────────────────────────────────────
bold "codeoid release-smoke @ $(git rev-parse --short HEAD 2>/dev/null || echo '?') ($(git branch --show-current 2>/dev/null || echo detached))"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  gray "  note: working tree has uncommitted changes — smoking the tree as-is."; echo
fi
echo

# ── Daemon gates (mirror CI) ──────────────────────────────────────────────────
run_stage "daemon: lint"      bun run lint
run_stage "workspace: versions" bun run check:versions
run_stage "daemon: typecheck" bun run typecheck
run_stage "daemon: test"      bun run test
run_stage "daemon: build"     bun run build

# ── Version coherence ─────────────────────────────────────────────────────────
version_coherence() {
  local built declared
  built="$(bun dist/cli.js --version 2>/dev/null | head -1 | tr -d '[:space:]')"
  declared="$(bun -e 'console.log(require("./package.json").version)' 2>/dev/null | tr -d '[:space:]')"
  echo "  built --version: ${built:-<none>}   package.json: ${declared:-<none>}"
  if [ -z "$built" ] || [ -z "$declared" ]; then
    echo "  could not read one of the versions"; return 1
  fi
  [ "$built" = "$declared" ]
}
run_stage "daemon: version coherence" version_coherence

# ── Daemon boot probe ─────────────────────────────────────────────────────────
DAEMON_PID=""
SMOKE_TMP=""
cleanup() {
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null && wait "$DAEMON_PID" 2>/dev/null
  [ -n "$SMOKE_TMP" ] && rm -rf "$SMOKE_TMP" 2>/dev/null
}
trap cleanup EXIT

boot_probe() {
  SMOKE_TMP="$(mktemp -d)"
  local port=$(( 20000 + RANDOM % 20000 ))
  local log="$SMOKE_TMP/daemon.log"
  echo "  starting daemon on 127.0.0.1:$port (isolated XDG_CONFIG_HOME, --no-web --no-telegram)"
  XDG_CONFIG_HOME="$SMOKE_TMP/config" \
    bun dist/cli.js start --port "$port" --host 127.0.0.1 --no-web --no-telegram \
    >"$log" 2>&1 &
  DAEMON_PID=$!

  # Wait (≤20s) for the deterministic ready log line, then confirm the port
  # actually accepts a TCP connection.
  local ready=0
  for _ in $(seq 1 100); do
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
      echo "  daemon process exited early:"; sed 's/^/    /' "$log" | tail -20; return 1
    fi
    if grep -q "daemon listening on" "$log" 2>/dev/null; then ready=1; break; fi
    sleep 0.2
  done
  if [ "$ready" != "1" ]; then
    echo "  daemon never logged readiness within 20s:"; sed 's/^/    /' "$log" | tail -20; return 1
  fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    # The subshell opens fd 3 in its own process and closes it on exit, so
    # there's nothing to close here — we only care about its exit status.
    echo "  daemon is listening and accepting connections"
  else
    echo "  ready logged but port $port refused a connection"; return 1
  fi

  kill "$DAEMON_PID" 2>/dev/null; wait "$DAEMON_PID" 2>/dev/null
  DAEMON_PID=""
  rm -rf "$SMOKE_TMP"; SMOKE_TMP=""
  return 0
}
run_stage "daemon: boot probe" boot_probe

# ── Web gates (mirror CI) ─────────────────────────────────────────────────────
run_stage "web: lint"      bash -c 'cd web && bun run lint'
run_stage "web: typecheck" bash -c 'cd web && bun run typecheck'
run_stage "web: test"      bash -c 'cd web && bun run test'
run_stage "web: build"     bash -c 'cd web && bun run build'

# ── Real-backend journeys (opt-in) ────────────────────────────────────────────
if [ "${CODEOID_SMOKE_INTEGRATION:-0}" = "1" ]; then
  backends="${CODEOID_SMOKE_BACKENDS:-claude}"
  integration() {
    echo "  backends: $backends (create → turn → reply; cross-backend fork → recall)"
    CODEOID_INTEGRATION=1 CODEOID_INTEGRATION_BACKENDS="$backends" \
      bun test src/tests/backends.integration.test.ts
  }
  run_stage "integration: backends ($backends)" integration
else
  skip_stage "integration: backends" \
    "set CODEOID_SMOKE_INTEGRATION=1 (and auth a backend) to run real-backend journeys"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
summary
[ "$FAILED" = "0" ]
