#!/usr/bin/env bash
# One-shot verification: the node suites first, then a real browser against a real server,
# driven over CDP. Everything exits with the script, including the Chrome it started in a
# temp profile.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates the cores and, with no CDP client attached, the process will not
# exit on its own. This game is 2D canvas, so plain headless Chrome is enough.
#
#   bash tools/verify.sh                              # node suites + @boot @play @routes @save @pointer
#   SCENARIOS="pointer" bash tools/verify.sh          # one browser suite while editing the view
#   SKIP_UNIT=1 bash tools/verify.sh                  # browser only (what the CI browser job does)
#   SHOTS=/tmp/puzzle-brief/shots bash tools/verify.sh # also keep boot + completed screenshots
#
# PORTS: this repo owns 5185 / 9345 and nothing else in z-biz-game may take them.
#   gridlock-cos, pentapack-cos and pocket-cube-cos all use 5180/9340; hashi-cos and
#   nine-rings-cos use 5181/9341 (pour-cos: 5190/9341); ferry-cos 5188/9348, tango-cos
#   5191/9351, akari-cos 9349, minesweeper-cos and nonogram-cos 9344. Colliding with one of
#   those pairs does not fail loudly: the DevTools port still answers, so the driver attaches
#   to the *sibling repo's* live tab, every assertion then runs against another game's
#   window.<hook>, and the worst case is a suite that reports "0 rows" and looks like a pass.
#   The port pair is therefore a correctness property, not a preference — which is also why
#   the guard below refuses to start on a bound port instead of quietly testing the wrong page.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9345}; if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo ":$CDP_PORT is already LISTENING — a sibling gate or an orphan Chrome holds it; attaching there reads someone else's browser. Wait for it to finish, or rerun with CDP_PORT=<a free port>." >&2; lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >&2 || true; exit 6; fi  # 一机一台：撞在同一个默认口上时不报错的是 Chrome，报错的是绿——先让路再开闸
WEB_PORT=${WEB_PORT:-5185}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# --- one headless Chrome per machine -------------------------------------------
# This box cannot host two DevTools servers at once, and an orphan left behind by a killed
# agent looks exactly like a healthy run from the outside: the port answers, the driver
# attaches, and the whole suite "passes" inside somebody else's browser. Refuse instead.
for p in "$CDP_PORT" "$WEB_PORT"; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | grep -q .; then
    echo "ABORT: port $p is already LISTENing — a previous run never cleaned up." >&2
    lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | tail -2 >&2
    echo "  Either wait for it to go away, or pick another pair: CDP_PORT=... WEB_PORT=... bash tools/verify.sh" >&2
    exit 3
  fi
done
# Another repo's browser is a *wait*, not an abort: the batch runs several repos on one host,
# and a fixed abort would report "0 rows" for a suite that never got a turn. Bounded wait,
# then a loud failure — never a silent skip.
if pgrep -f 'remote-debugging-port' >/dev/null 2>&1; then
  echo "waiting for the other headless Chrome to exit (up to ${CHROME_WAIT:-180}s)..." >&2
  for i in $(seq 1 $(( ${CHROME_WAIT:-180} / 5 ))); do
    pgrep -f 'remote-debugging-port' >/dev/null 2>&1 || break
    sleep 5
  done
fi
if pgrep -f 'remote-debugging-port' >/dev/null 2>&1; then
  # It did not go away inside the wait. Two possibilities: another repo is mid-run, or a killed
  # agent left an orphan that will never exit (this has happened on this host — a Chrome on :9348
  # and its server on :5188 outlived their parent shell by the hour). Refusing forever would make
  # the suite un-runnable either way, so the failure mode is narrowed to the one that actually
  # corrupts a result: *attaching to the wrong tab*. That cannot happen here, because the LISTEN
  # check above already proved :$CDP_PORT and :$WEB_PORT are ours alone — a sibling's DevTools
  # answers on its own port and this driver only ever dials its own. What is left is CPU
  # contention, and every wait in playtest.mjs polls instead of sleeping, so a busy machine makes
  # the run slower, not wrong. Say it out loud, then go.
  echo "note: another headless Chrome is still up after ${CHROME_WAIT:-180}s; continuing on this repo's own pair :$CDP_PORT / :$WEB_PORT" >&2
  pgrep -fl 'remote-debugging-port' | head -2 >&2
fi

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1000,820 --no-first-run --no-default-browser-check about:blank >/tmp/matchwork-chrome.log 2>&1 &
CHPID=$!
node "$HERE/server.cjs" "$WEB_PORT" >/tmp/matchwork-server.log 2>&1 &
WEBPID=$!
CLEANED=
cleanup() {
  # Idempotent: the EXIT trap and the explicit call before the leftover audit below both run
  # it, and the audit is only truthful if the kill happened first — otherwise the script
  # counts *its own* Chrome and server as orphans and reports a leak it does not have.
  [ -n "$CLEANED" ] && return 0
  CLEANED=1
  # kill -9 for both, then `wait` for both: skipping the wait is what makes the terminal
  # fill up with `Killed: 9` after the tests already finished, and skipping one PID leaks
  # the server (or the browser) into the next run.
  kill -9 $CHPID $WEBPID 2>/dev/null
  wait $CHPID 2>/dev/null
  wait $WEBPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# Watchdog redirects its fds: a background subshell inherits the script's stdout, and if this
# runs inside a pipeline it would hold the write end open for the full timeout and stall the
# consumer long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, and the page
# cannot be fetched before the server answers, so wait on both endpoints rather than guessing
# a sleep duration.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; tail -5 /tmp/matchwork-chrome.log >&2; exit 4; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; tail -5 /tmp/matchwork-server.log >&2; exit 5; }

cd "$HERE" || exit 1
FAILED=0

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are their own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" || FAILED=1
  done
  # 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑（59 仓同形）。「本地全绿、线上 404 自己的
  # manifest / sw.js / 图标」这一类坏法缺的就是这一步。它不碰 Chrome，所以放在 node suites 里。
  echo "=== deploy-set ==="
  node tools/deploy-set.mjs || FAILED=1
  node tools/deploy-set-selftest.mjs || FAILED=1
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js is 60 rows and the shell resolves a route before it reports a state, so
# wait on window.matchwork rather than on a timer.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.matchwork?window.matchwork.state.id+' par='+window.matchwork.state.par:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
case "$BOOT" in *nope*|"") echo "window.matchwork never appeared at $BASE" >&2; exit 6;; esac

# @save runs last of the page-side suites and @pointer afterwards reads what it wrote; each
# scenario runs in its own driver process, which is what makes the reload between them real.
for s in ${SCENARIOS:-boot play routes save pointer}; do
  echo "=== @$s ==="
  OUT=$(node tools/playtest.mjs eval "@$s" nonav 2>&1)
  printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-300:]); sys.exit(1)
# Brace counting, not JSON.parse of a line: headless Chrome appends its own text after the
# console payload on the same line, and a line-based parse then fails on a run that passed.
depth = 0
end = -1
for i in range(start, len(raw)):
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            end = i + 1
            break
if end < 0:
    print("TRUNCATED RESULT", raw[start:start+200]); sys.exit(1)
try: d = json.loads(raw[start:end])
except Exception as e:
    print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", [r["test"] for r in rows if not r.get("pass")])
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r.get("detail"), ensure_ascii=False)[:300])
sys.exit(1 if any(not r.get("pass") for r in rows) or not rows else 0)
' || FAILED=1
  # A clean console is part of the contract: a thrown page error, a refused resource or a
  # rendering warning all count, even when every assertion above happened to pass.
  if printf '%s' "$OUT" | grep -qE '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]'; then
    echo "  CONSOLE NOT CLEAN for @$s"
    printf '%s\n' "$OUT" | grep -E '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]' | head -5
    FAILED=1
  fi
  node tools/playtest.mjs shot "/tmp/matchwork-$s.png" >/dev/null 2>&1
  # SHOTS=<dir> keeps the two pictures a human reviews: the shell as it booted, and the victory
  # card as a real drag (not an injected call) put it up at the end of @pointer.
  if [ -n "${SHOTS:-}" ] && [ -f "/tmp/matchwork-$s.png" ]; then
    mkdir -p "$SHOTS" 2>/dev/null
    case "$s" in
      boot) cp "/tmp/matchwork-boot.png" "$SHOTS/matchwork-boot.png" ;;
      pointer) cp "/tmp/matchwork-pointer.png" "$SHOTS/matchwork-completed.png" ;;
    esac
  fi
done

echo "=== console ==="
node tools/playtest.mjs logs
kill $WD 2>/dev/null
wait $WD 2>/dev/null

# --- nothing may outlive this script -------------------------------------------
# An orphaned Chrome or `node server.cjs` is how a later run reports 0 failures without
# having run anything at all, so the last thing verify.sh does is prove it left nothing.
cleanup            # the real kill happens here, so the audit below is not looking at our own PIDs
# Reaping can lag a killed process by a moment; bounded poll, then report what is really left.
for i in $(seq 1 20); do
  LEFT=$(ps -Ao command= | awk -v p="${CDP_PORT}" 'index($0, "remote-debugging-port=" p) && !/--type=/' | wc -l | tr -d ' ')  # port concatenated inside awk: the -v needle would otherwise match this very pipeline
  LEFT_SRV=$(pgrep -f "server.cjs $WEB_PORT" 2>/dev/null | wc -l | tr -d ' ')
  [ "$LEFT" = "0" ] && [ "$LEFT_SRV" = "0" ] && break
  sleep 0.25
done
if [ "$LEFT" != "0" ] || [ "$LEFT_SRV" != "0" ]; then
  echo "LEFTOVER PROCESSES: chrome=$LEFT server=$LEFT_SRV" >&2
  pgrep -fl "remote-debugging-port=$CDP_PORT|server.cjs $WEB_PORT" >&2
  FAILED=1
fi
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
