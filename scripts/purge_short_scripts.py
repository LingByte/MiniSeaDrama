#!/usr/bin/env python3
"""删除分集过少的脏剧本（默认 ≤5 集）及其订单。"""
import json, re, sys
from pathlib import Path

import pymysql

MAX_EPS = int(sys.argv[1]) if len(sys.argv) > 1 else 5
DRY = "--dry-run" in sys.argv

root = Path(__file__).resolve().parents[1]
dsn = None
for line in (root / ".env").read_text().splitlines():
    line = line.strip()
    if line.startswith("APP_DATABASE_DSN="):
        dsn = line.split("=", 1)[1].strip().strip('"').strip("'")
        break
if not dsn:
    sys.exit("missing APP_DATABASE_DSN")
m = re.match(r"([^:]+):([^@]+)@tcp\(([^)]+)\)/([^?]+)", dsn)
if not m:
    sys.exit(f"bad dsn: {dsn}")
user, pwd, hostport, db = m.groups()
host, port = hostport.split(":")

conn = pymysql.connect(host=host, port=int(port), user=user, password=pwd, database=db, charset="utf8mb4")
cur = conn.cursor()
cur.execute("SELECT script_id, payload FROM admin_scripts")
deleted = 0
for sid, payload in cur.fetchall():
    script = json.loads(payload or "{}")
    n = len(script.get("episodes") or [])
    if n > MAX_EPS:
        continue
    title = script.get("title") or ""
    print(f"DEL {sid}  eps={n}  {title}")
    if DRY:
        deleted += 1
        continue
    cur.execute("DELETE FROM orders WHERE script_id=%s", (sid,))
    cur.execute("DELETE FROM admin_scripts WHERE script_id=%s", (sid,))
    deleted += 1
if not DRY:
    conn.commit()
cur.execute("SELECT COUNT(*) FROM admin_scripts")
left = cur.fetchone()[0]
print(f"done deleted={deleted} remaining={left} dry={DRY} max={MAX_EPS}")
conn.close()
