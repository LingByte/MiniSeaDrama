#!/usr/bin/env python3
"""一次性脚本：把库里 data:image / 超长 base64 封面迁到本地对象存储 uploads/，再回写 key。

用法（仓库根目录）:
  python3 scripts/purge_base64_covers.py

依赖: pip install pymysql
读取根目录 .env 的 APP_DATABASE_DSN / APP_STORAGE_ROOT。
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def parse_mysql_dsn(dsn: str) -> dict:
    # user:pass@tcp(host:port)/db?params
    m = re.match(
        r"^(?P<user>[^:]+):(?P<password>.+)@tcp\((?P<host>[^:]+):(?P<port>\d+)\)/(?P<db>[^?]+)",
        dsn,
    )
    if not m:
        raise SystemExit(f"无法解析 APP_DATABASE_DSN: {dsn[:60]}...")
    return {
        "user": m.group("user"),
        "password": m.group("password"),
        "host": m.group("host"),
        "port": int(m.group("port")),
        "database": m.group("db"),
        "charset": "utf8mb4",
    }


def sanitize(s: str) -> str:
    out = re.sub(r"[^a-zA-Z0-9_-]", "", s or "")
    return out or "item"


def ext_from_meta(meta: str) -> str:
    meta = meta.lower()
    if "image/jpeg" in meta or "image/jpg" in meta:
        return ".jpg"
    if "image/webp" in meta:
        return ".webp"
    if "image/gif" in meta:
        return ".gif"
    return ".png"


def upload_data_url(uploads: Path, prefix: str, owner: str, data_url: str) -> str:
    if "," not in data_url:
        raise ValueError("invalid data url")
    meta, raw = data_url.split(",", 1)
    raw = unquote(raw) if ";base64" not in meta.lower() else raw
    try:
        blob = base64.b64decode(raw, validate=False)
    except Exception as e:
        raise ValueError(f"base64 decode failed: {e}") from e
    if not blob:
        raise ValueError("empty image")
    ext = ext_from_meta(meta)
    key = f"{prefix}/{sanitize(owner)}/{time.time_ns()}{ext}"
    dest = uploads / key
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(blob)
    return key


def normalize_value(uploads: Path, prefix: str, owner: str, value: str) -> tuple[str, str]:
    """返回 (new_value, action) action=keep|uploaded|cleared"""
    value = (value or "").strip()
    if not value:
        return "", "keep"
    if value.startswith(("http://", "https://")):
        if len(value) > 2048:
            return "", "cleared"
        return value, "keep"
    if value.startswith("data:"):
        try:
            return upload_data_url(uploads, prefix, owner, value), "uploaded"
        except Exception:
            return "", "cleared"
    if len(value) > 2048:
        return "", "cleared"
    return value, "keep"


def walk_json(obj, uploads: Path, owner: str, stats: dict) -> bool:
    changed = False
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if isinstance(v, str) and (v.startswith("data:") or (k == "cover" and len(v) > 2048)):
                nxt, action = normalize_value(uploads, "covers", owner, v)
                stats[action] = stats.get(action, 0) + 1
                if nxt != v:
                    obj[k] = nxt
                    changed = True
            elif isinstance(v, (dict, list)):
                if walk_json(v, uploads, owner, stats):
                    changed = True
    elif isinstance(obj, list):
        for item in obj:
            if walk_json(item, uploads, owner, stats):
                changed = True
    return changed


def main() -> None:
    try:
        import pymysql
    except ImportError:
        raise SystemExit("请先安装: pip install pymysql")

    env = {**load_env(ROOT / ".env"), **os.environ}
    dsn = env.get("APP_DATABASE_DSN", "").strip()
    if not dsn:
        raise SystemExit("缺少 APP_DATABASE_DSN")
    uploads = ROOT / env.get("APP_STORAGE_ROOT", "uploads")
    uploads.mkdir(parents=True, exist_ok=True)

    cfg = parse_mysql_dsn(dsn)
    conn = pymysql.connect(
        host=cfg["host"],
        port=cfg["port"],
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        charset=cfg["charset"],
        autocommit=False,
    )
    stats = {"uploaded": 0, "cleared": 0, "scripts": 0, "orders": 0, "users": 0}

    try:
        with conn.cursor() as cur:
            cur.execute("SELECT script_id, payload FROM admin_scripts")
            rows = cur.fetchall()
            for script_id, payload in rows:
                if not payload or "data:" not in payload:
                    continue
                try:
                    data = json.loads(payload)
                except json.JSONDecodeError:
                    print(f"skip script {script_id}: bad json")
                    continue
                if walk_json(data, uploads, script_id, stats):
                    cur.execute(
                        "UPDATE admin_scripts SET payload=%s WHERE script_id=%s",
                        (json.dumps(data, ensure_ascii=False), script_id),
                    )
                    stats["scripts"] += 1
                    print(f"script {script_id}: updated")

            cur.execute("SELECT id, script_id, cover FROM orders")
            for oid, script_id, cover in cur.fetchall():
                if not cover:
                    continue
                if not (cover.startswith("data:") or len(cover) > 2048):
                    continue
                nxt, action = normalize_value(uploads, "covers", script_id or oid, cover)
                stats[action] = stats.get(action, 0) + 1
                if nxt != cover:
                    cur.execute("UPDATE orders SET cover=%s WHERE id=%s", (nxt, oid))
                    stats["orders"] += 1
                    print(f"order {oid}: {action}")

            try:
                cur.execute("SELECT id, avatar FROM users")
                for uid, avatar in cur.fetchall():
                    if not avatar:
                        continue
                    if not (avatar.startswith("data:") or len(avatar) > 2048):
                        continue
                    nxt, action = normalize_value(uploads, "avatars", f"u{uid}", avatar)
                    stats[action] = stats.get(action, 0) + 1
                    if nxt != avatar:
                        cur.execute("UPDATE users SET avatar=%s WHERE id=%s", (nxt, uid))
                        stats["users"] += 1
                        print(f"user {uid}: {action}")
            except pymysql.err.ProgrammingError:
                pass

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print(
        f"done: scripts={stats['scripts']} orders={stats['orders']} users={stats['users']} "
        f"uploaded={stats.get('uploaded', 0)} cleared={stats.get('cleared', 0)} root={uploads}"
    )


if __name__ == "__main__":
    main()
