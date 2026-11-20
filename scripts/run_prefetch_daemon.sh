#!/bin/bash
# 双 fork 守护进程：脱离当前终端 / Cursor，后台持续跑到结束
# 用法:
#   ./scripts/run_prefetch_daemon.sh                 # 从 0 起拉完整个目录（有英文字幕的全收下）
#   ./scripts/run_prefetch_daemon.sh 100 200         # 从 offset=200 起拉完
#   ./scripts/run_prefetch_daemon.sh 100 200 once    # 只跑一批（旧行为）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/pipeline
LOG="$PWD/data/pipeline/prefetch.log"
PIDF="$PWD/data/pipeline/prefetch.pid"
PY="$PWD/scripts/prefetch_shortflix_subs.py"
LIMIT="${1:-100}"
OFFSET="${2:-0}"
MODE="${3:-until-end}"   # until-end | once

if [[ -f "$PIDF" ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  echo "already running pid=$(cat "$PIDF")  log=$LOG"
  exit 0
fi

rm -f "$PIDF"

python3 - "$LOG" "$PIDF" "$PY" "$LIMIT" "$OFFSET" "$MODE" <<'PY'
import os, sys, time
from pathlib import Path

log, pidf, script = map(Path, sys.argv[1:4])
limit, offset, mode = sys.argv[4], sys.argv[5], sys.argv[6]

def daemonize():
    if os.fork() > 0:
        return False
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.chdir(str(script.parent.parent))
    os.umask(0)
    with open("/dev/null", "rb") as devnull, open(log, "ab", buffering=0) as out:
        os.dup2(devnull.fileno(), 0)
        os.dup2(out.fileno(), 1)
        os.dup2(out.fileno(), 2)
    return True

if not daemonize():
    for _ in range(50):
        if pidf.exists():
            print(f"started pid={pidf.read_text().strip()} log={log} limit={limit} offset={offset} mode={mode}")
            break
        time.sleep(0.1)
    else:
        print("failed to start (no pid file)", file=sys.stderr)
        sys.exit(1)
    sys.exit(0)

pidf.write_text(str(os.getpid()))
os.environ["PYTHONUNBUFFERED"] = "1"
sys.stdout.write(f"\n===== daemon start pid={os.getpid()} limit={limit} offset={offset} mode={mode} =====\n")
sys.stdout.flush()
argv = [sys.executable, "-u", str(script), "--limit", limit, "--offset", offset, "--workers", "1"]
if mode != "once":
    argv.append("--until-end")
os.execv(sys.executable, argv)
PY
