#!/usr/bin/env python3
"""一次性预拉 ShortFlix 官方英文字幕到 data/pipeline/，供网页「开始生成」复用。

目录与 Go pipeline 一致：
  data/pipeline/{Title} [{slug}]/subtitles/E001.vtt
  data/pipeline/{Title} [{slug}]/series.json

用法（仓库根目录）:
  python3 scripts/prefetch_shortflix_subs.py           # 默认 100 部
  python3 scripts/prefetch_shortflix_subs.py --limit 20
  python3 scripts/prefetch_shortflix_subs.py --workers 6

读取 .env 的 SHORTFLIX_EMAIL / SHORTFLIX_PASSWORD。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
socket.setdefaulttimeout(45)
_http_lock = threading.Lock()
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36"
)
LOGIN_URL = "https://www.shortflix.net/api/auth/sign-in/email"
SESSION_NAME = "__Secure-better-auth.session_token"
NEXT_PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)')


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


def safe_filename(value: str, fallback: str = "drama") -> str:
    out = []
    for ch in (value or "").strip():
        if ord(ch) < 32 or ch in '<>:"/\\|?*':
            out.append("_")
        else:
            out.append(ch)
    cleaned = " ".join("".join(out).split()).strip(" .")
    if not cleaned:
        return fallback
    return cleaned[:100]


def looks_english(content: str) -> bool:
    letters = latin = 0
    for ch in content:
        if ch.isalpha():
            letters += 1
            if "A" <= ch <= "Z" or "a" <= ch <= "z":
                latin += 1
    if letters < 20:
        return bool(re.search(r"[A-Za-z]{3,}", content))
    return latin / letters > 0.55


def title_is_english(title: str) -> bool:
    t = (title or "").lower()
    return "en" in t or "english" in t or "eng" in t


def title_is_other(title: str) -> bool:
    t = (title or "").lower()
    return "zh" in t or "chi" in t or "中" in t or "cn" in t


class ShortFlix:
    def __init__(self, email: str, password: str) -> None:
        self.email = email
        self.password = password
        self.cookie = ""
        self.opener = urllib.request.build_opener()

    def sign_in(self) -> None:
        body = json.dumps({"email": self.email, "password": self.password}).encode()
        req = urllib.request.Request(
            LOGIN_URL,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "*/*",
                "User-Agent": UA,
                "Origin": "https://www.shortflix.net",
                "Referer": "https://www.shortflix.net/login",
                "no-redirect": "true",
            },
        )
        with self.opener.open(req, timeout=30) as resp:
            if resp.status != 200:
                raise SystemExit(f"ShortFlix 登录失败 HTTP {resp.status}")
            token = ""
            for raw in resp.headers.get_all("Set-Cookie") or []:
                if raw.startswith(SESSION_NAME + "="):
                    token = raw.split(";", 1)[0].split("=", 1)[1]
                    break
            if not token:
                raise SystemExit("登录成功但未拿到 session cookie")
            self.cookie = f"{SESSION_NAME}={token}"
            print("ShortFlix 登录成功")

    def _headers(self, accept: str, referer: str = "https://www.shortflix.net/") -> dict:
        h = {
            "User-Agent": UA,
            "Accept": accept,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": referer,
        }
        if self.cookie:
            h["Cookie"] = self.cookie
        return h

    def get_text(self, url: str, timeout: int = 45) -> str:
        req = urllib.request.Request(url, headers=self._headers("text/html,application/xhtml+xml"))
        with _http_lock:
            with self.opener.open(req, timeout=timeout) as resp:
                if resp.status >= 400:
                    raise RuntimeError(f"HTTP {resp.status}")
                return resp.read().decode("utf-8", errors="replace")

    def get_json(self, url: str, timeout: int = 45) -> dict:
        req = urllib.request.Request(url, headers=self._headers("application/json"))
        with _http_lock:
            with self.opener.open(req, timeout=timeout) as resp:
                if resp.status >= 400:
                    raise RuntimeError(f"HTTP {resp.status}")
                return json.loads(resp.read().decode("utf-8"))

    def download_bytes(self, url: str, timeout: int = 60) -> bytes:
        req = urllib.request.Request(url, headers=self._headers("*/*"))
        with _http_lock:
            with self.opener.open(req, timeout=timeout) as resp:
                data = resp.read()
                if resp.status >= 400:
                    raise RuntimeError(f"HTTP {resp.status}")
                return data

    def catalog_page(self, cursor: str = "", limit: int = 48) -> dict:
        q = {"limit": str(limit), "language": "zh_TW", "lang": "zh_TW"}
        if cursor:
            q["cursor"] = cursor
        url = "https://www.shortflix.net/api/search?" + urllib.parse.urlencode(q)
        return self.get_json(url)


def decode_next_payload(html: str) -> str:
    chunks = []
    for m in NEXT_PUSH_RE.finditer(html):
        try:
            chunks.append(json.loads(m.group(1)))
        except json.JSONDecodeError:
            continue
    if not chunks:
        raise RuntimeError("页面结构变化：无 Next payload")
    return "".join(chunks)


def find_series_object(payload: str) -> dict:
    marker = '"video":'
    cursor = 0
    candidates = []
    while True:
        idx = payload.find(marker, cursor)
        if idx < 0:
            break
        cursor = idx + len(marker)
        try:
            obj, _ = json.JSONDecoder().raw_decode(payload[cursor:])
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("slug") and isinstance(obj.get("episodes"), list) and obj["episodes"]:
            candidates.append(obj)
    if not candidates:
        raise RuntimeError("页面结构变化：无剧目 JSON")
    return max(candidates, key=lambda c: len(c.get("episodes") or []))


def parse_subs(raw) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        url = str(item.get("fileUrl") or "").strip()
        if url.startswith("//"):
            url = "https:" + url
        elif url.startswith("/"):
            url = "https://www.shortflix.net" + url
        if not url or url in seen:
            continue
        seen.add(url)
        fmt = str(item.get("format") or "VTT").upper()
        out.append({"title": str(item.get("title") or ""), "format": fmt, "url": url})
    return out


def parse_series_html(html: str, source_url: str) -> dict:
    raw = find_series_object(decode_next_payload(html))
    episodes = []
    for ep in raw.get("episodes") or []:
        if not isinstance(ep, dict):
            continue
        try:
            num = int(ep.get("episodeNumber") or 0)
        except (TypeError, ValueError):
            continue
        if num <= 0:
            continue
        versions = []
        for ver in ep.get("versions") or []:
            if not isinstance(ver, dict):
                continue
            video = str(ver.get("videoUrl") or "").strip()
            if not video.startswith("http"):
                continue
            subs = parse_subs(ver.get("subtitlesList")) or parse_subs(ver.get("subtitles"))
            versions.append(
                {
                    "quality": str(ver.get("quality") or ""),
                    "language": str(ver.get("lang") or ""),
                    "video_url": video,
                    "subtitles": subs,
                    "hard_sub": bool(ver.get("hardSub")),
                }
            )
        versions.sort(key=lambda v: int(re.search(r"(\d+)", v["quality"]).group(1)) if re.search(r"(\d+)", v["quality"]) else 0, reverse=True)
        episodes.append(
            {
                "number": num,
                "title": str(ep.get("title") or ""),
                "duration": int(ep.get("duration") or 0),
                "versions": versions,
            }
        )
    episodes.sort(key=lambda e: e["number"])
    if not episodes:
        raise RuntimeError("无剧集")
    title = str(raw.get("title") or raw.get("slug") or "")
    cover = str(raw.get("thumbnailUrl") or raw.get("coverUrl") or "").strip()
    return {
        "title": title,
        "slug": str(raw.get("slug") or ""),
        "cover": cover,
        "source_url": source_url,
        "episodes": episodes,
    }


def discover_series(client: ShortFlix, source_url: str) -> dict:
    html = client.get_text(source_url)
    initial = parse_series_html(html, source_url)
    merged = {ep["number"]: ep for ep in initial["episodes"]}
    missing = [n for n, ep in merged.items() if not ep["versions"]]
    if missing and not client.cookie:
        raise RuntimeError("需要登录才能解锁全部剧集")

    def fetch_one(n: int) -> None:
        page = f"https://www.shortflix.net/videos/{initial['slug']}/episode-{n}"
        try:
            series = parse_series_html(client.get_text(page), page)
        except Exception:
            return
        for ep in series["episodes"]:
            cur = merged.get(ep["number"])
            if ep["versions"] and (not cur or not cur["versions"]):
                merged[ep["number"]] = ep

    # 串行补全缺集（最多补 80 集，避免一部剧卡死整批）
    todo = missing[:80]
    for i, n in enumerate(todo, 1):
        if i == 1 or i % 5 == 0 or i == len(todo):
            print(f"  unlock {i}/{len(todo)} ep-{n}", flush=True)
        try:
            fetch_one(n)
        except Exception as e:
            print(f"  warn ep-{n}: {e}", flush=True)
        time.sleep(0.05)

    available = [ep for ep in merged.values() if ep["versions"]]
    available.sort(key=lambda e: e["number"])
    unresolved = sorted(n for n, ep in merged.items() if not ep["versions"])
    if not available:
        raise RuntimeError("无可下载版本")
    # 缺几集也不整部作废：先拉已解锁的
    if unresolved:
        print(f"  warn 《{initial['title']}》仍缺 {len(unresolved)} 集未解锁，先拉已有 {len(available)} 集", flush=True)
    return {
        "title": initial["title"],
        "slug": initial["slug"],
        "cover": initial["cover"],
        "source_url": source_url,
        "episodes": available,
    }


def english_candidates(ep: dict) -> list[dict]:
    seen, scored = set(), []
    for ver in ep.get("versions") or []:
        for sub in ver.get("subtitles") or []:
            url = sub.get("url")
            if not url or url in seen:
                continue
            seen.add(url)
            if title_is_other(sub.get("title") or ""):
                continue
            score = 2 if title_is_english(sub.get("title") or "") else 1
            scored.append((score, sub))
    scored.sort(key=lambda x: -x[0])
    return [s for _, s in scored]


def workdir_for(root: Path, title: str, slug: str) -> Path:
    folder = f"{safe_filename(title)} [{safe_filename(slug, 'series')}]"
    return root / folder


def existing_ok(subs_dir: Path, number: int) -> Path | None:
    for suffix in (".vtt", ".srt"):
        p = subs_dir / f"E{number:03d}{suffix}"
        if p.exists() and p.stat().st_size > 0:
            try:
                if looks_english(p.read_text(encoding="utf-8", errors="replace")):
                    return p
            except OSError:
                pass
    return None


def download_ep_sub(client: ShortFlix, ep: dict, subs_dir: Path) -> tuple[str, str]:
    hit = existing_ok(subs_dir, ep["number"])
    if hit:
        return str(hit), "cached"
    last_err = "无英文字幕轨"
    for sub in english_candidates(ep):
        suffix = ".vtt" if "VTT" in (sub.get("format") or "").upper() else ".srt"
        target = subs_dir / f"E{ep['number']:03d}{suffix}"
        for attempt in range(1, 5):
            try:
                data = client.download_bytes(sub["url"])
                text = data.decode("utf-8", errors="replace")
                if not looks_english(text):
                    last_err = "字幕不是英文"
                    break
                target.parent.mkdir(parents=True, exist_ok=True)
                tmp = target.with_suffix(target.suffix + ".part")
                tmp.write_bytes(data)
                tmp.replace(target)
                return str(target), "downloaded"
            except Exception as e:
                last_err = str(e)
                if attempt < 4 and any(x in last_err for x in ("502", "503", "504", "429")):
                    time.sleep(attempt)
                    continue
                break
    return "", last_err


def collect_catalog(client: ShortFlix, limit: int, offset: int = 0) -> list[dict]:
    """拉取目录；offset 跳过前 N 部，limit 为本次要处理的数量。"""
    need = max(0, offset) + max(0, limit)
    items, cursor, seen = [], "", set()
    while len(items) < need:
        page = client.catalog_page(cursor=cursor, limit=min(48, need - len(items) + 5))
        batch = page.get("items") or []
        if not batch:
            break
        for it in batch:
            slug = (it.get("slug") or "").strip()
            title = (it.get("title") or "").strip()
            if not slug or not title or slug in seen:
                continue
            seen.add(slug)
            items.append(
                {
                    "title": title,
                    "slug": slug,
                    "cover": (it.get("thumbnailUrl") or "").strip(),
                    "source_url": f"https://www.shortflix.net/videos/{slug}/episode-1",
                }
            )
            if len(items) >= need:
                break
        if not page.get("hasMore") or not page.get("nextCursor"):
            break
        cursor = page["nextCursor"]
        time.sleep(0.3)
    return items[offset : offset + limit]


def count_existing_subs(wd: Path) -> int:
    subs = wd / "subtitles"
    if not subs.is_dir():
        return 0
    n = 0
    for p in subs.iterdir():
        if p.suffix.lower() in (".vtt", ".srt") and p.name.startswith("E") and p.stat().st_size > 0:
            n += 1
    return n


def prefetch_one(client: ShortFlix, item: dict, root: Path) -> dict:
    title, slug, url = item["title"], item["slug"], item["source_url"]
    wd = workdir_for(root, title, slug)
    # 已有较完整缓存：跳过 discover，省时间
    existing = count_existing_subs(wd)
    if existing >= 20 and (wd / "series.json").exists():
        return {
            "slug": slug,
            "title": title,
            "ok": True,
            "episodes": existing,
            "subs_ok": existing,
            "subs_fail": 0,
            "cached": existing,
            "downloaded": 0,
            "workdir": str(wd.relative_to(root)) if wd.exists() else slug,
            "errors": [],
            "skipped": True,
        }

    subs_dir = wd / "subtitles"
    for name in ("videos", "audio", "subtitles", "text", "series", "prompt", "output"):
        (wd / name).mkdir(parents=True, exist_ok=True)

    try:
        series = discover_series(client, url)
    except Exception as e:
        return {"slug": slug, "title": title, "ok": False, "error": f"discover: {e}"}

    # 标题以页面为准，目录可能需对齐
    real_wd = workdir_for(root, series["title"], series["slug"])
    if real_wd != wd:
        if not real_wd.exists():
            try:
                wd.rename(real_wd)
            except OSError:
                pass
        wd = real_wd
        subs_dir = wd / "subtitles"
        subs_dir.mkdir(parents=True, exist_ok=True)

    (wd / "series.json").write_text(json.dumps(series, ensure_ascii=False, indent=2), encoding="utf-8")

    ok = fail = cached = downloaded = 0
    errors = []
    total_eps = len(series["episodes"])
    # 前 N 集都无英文字幕轨 → 整剧判定 hard_only，不再扫完全部集数
    probe = min(5, total_eps)
    for i, ep in enumerate(series["episodes"], 1):
        if i == 1 or i % 10 == 0 or i == total_eps:
            print(f"  subs {i}/{total_eps}", flush=True)
        path, action = download_ep_sub(client, ep, subs_dir)
        if path:
            ok += 1
            if action == "cached":
                cached += 1
            else:
                downloaded += 1
        else:
            fail += 1
            if len(errors) < 5:
                errors.append(f"E{ep['number']:03d}:{action}")
        # 前 probe 集全部失败且都是无英文字幕轨 → 提前结束
        if i == probe and ok == 0 and fail >= probe:
            if all("无英文字幕轨" in (e.split(":", 1)[-1] if ":" in e else e) for e in errors[:probe]):
                print(f"  前 {probe} 集无英文字幕轨，跳过剩余 {total_eps - probe} 集", flush=True)
                fail = total_eps  # 记为整剧无软轨
                break
        time.sleep(0.03)

    return {
        "slug": series["slug"],
        "title": series["title"],
        "ok": ok > 0,
        "episodes": len(series["episodes"]),
        "subs_ok": ok,
        "subs_fail": fail,
        "cached": cached,
        "downloaded": downloaded,
        "workdir": str(wd.relative_to(root)),
        "errors": errors,
    }


def merge_manifest(root: Path, offset: int, limit: int, results: list) -> tuple[int, int, int]:
    """合并写入 prefetch_manifest.json，返回 (batch_ok, total_ok, total_count)。"""
    ok_n = sum(1 for r in results if r.get("ok"))
    man_path = root / "prefetch_manifest.json"
    prev_results: list = []
    if man_path.exists():
        try:
            prev = json.loads(man_path.read_text(encoding="utf-8"))
            prev_results = list(prev.get("results") or [])
        except Exception:
            prev_results = []
    by_slug = {r.get("slug"): r for r in prev_results if r.get("slug")}
    for r in results:
        if r.get("slug"):
            by_slug[r["slug"]] = r
    merged = list(by_slug.values())
    ok_all = sum(1 for r in merged if r.get("ok"))
    manifest = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "last_offset": offset,
        "last_limit": limit,
        "ok": ok_all,
        "fail": len(merged) - ok_all,
        "count": len(merged),
        "last_batch": {"ok": ok_n, "fail": len(results) - ok_n, "offset": offset, "limit": limit},
        "results": merged,
    }
    man_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"\ndone batch: ok={ok_n} fail={len(results) - ok_n}  (累计 ok={ok_all} / {len(merged)}) root={root}",
        flush=True,
    )
    print(f"manifest: {man_path}", flush=True)
    return ok_n, ok_all, len(merged)


def run_batch(client: ShortFlix, catalog: list, root: Path, workers: int, offset: int) -> list:
    results = []
    total = len(catalog)
    if workers <= 1:
        for i, item in enumerate(catalog, 1):
            print(f"[{i}/{total}] 处理 《{item['title']}》(#{offset + i})…", flush=True)
            try:
                r = prefetch_one(client, item, root)
            except Exception as e:
                r = {"slug": item["slug"], "title": item["title"], "ok": False, "error": str(e)}
                traceback.print_exc()
            results.append(r)
            status = "OK" if r.get("ok") else "FAIL"
            if r.get("skipped"):
                detail = f"skip cache={r.get('cached')}"
            elif r.get("ok"):
                detail = (
                    f"eps={r.get('episodes')} subs={r.get('subs_ok')}/{r.get('episodes')} "
                    f"dl={r.get('downloaded')} cache={r.get('cached')}"
                )
            else:
                detail = r.get("error") or r.get("errors")
            print(f"[{i}/{total}] {status} 《{r.get('title')}》 {detail}", flush=True)
        return results

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(prefetch_one, client, item, root): item for item in catalog}
        done = 0
        for fut in concurrent.futures.as_completed(futs):
            done += 1
            item = futs[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {"slug": item["slug"], "title": item["title"], "ok": False, "error": str(e)}
            results.append(r)
            status = "OK" if r.get("ok") else "FAIL"
            detail = (
                f"eps={r.get('episodes')} subs={r.get('subs_ok')}/{r.get('episodes')} "
                f"dl={r.get('downloaded')} cache={r.get('cached')}"
                if r.get("ok")
                else r.get("error") or r.get("errors")
            )
            print(f"[{done}/{total}] {status} 《{r.get('title')}》 {detail}", flush=True)
    return results


def main() -> None:
    ap = argparse.ArgumentParser(description="预拉 ShortFlix 英文字幕到 data/pipeline")
    ap.add_argument("--limit", type=int, default=100, help="每批多少部（默认 100）")
    ap.add_argument("--offset", type=int, default=0, help="跳过目录前 N 部（续拉用）")
    ap.add_argument(
        "--until-end",
        action="store_true",
        help="从 offset 起一批批拉到目录尽头，有英文字幕的全部收下",
    )
    ap.add_argument("--workers", type=int, default=1, help="并行部数（默认 1 串行更稳）")
    ap.add_argument("--root", default="", help="输出根目录，默认 data/pipeline")
    args = ap.parse_args()

    env = {**load_env(ROOT / ".env"), **os.environ}
    email = (env.get("SHORTFLIX_EMAIL") or "").strip()
    password = env.get("SHORTFLIX_PASSWORD") or ""
    if not email or not password:
        raise SystemExit("请在 .env 配置 SHORTFLIX_EMAIL / SHORTFLIX_PASSWORD")

    root = Path(args.root) if args.root else ROOT / "data" / "pipeline"
    root.mkdir(parents=True, exist_ok=True)

    client = ShortFlix(email, password)
    client.sign_in()

    offset = max(0, args.offset)
    batch_size = max(1, args.limit)
    workers = max(1, args.workers)

    while True:
        print(f"拉取目录，offset={offset} limit={batch_size}…", flush=True)
        catalog = collect_catalog(client, batch_size, offset=offset)
        if not catalog:
            print(f"目录已空（offset={offset}），全部扫完。", flush=True)
            break
        print(
            f"目录拿到 {len(catalog)} 部（#{offset + 1}–#{offset + len(catalog)}），开始下字幕 → {root}",
            flush=True,
        )
        results = run_batch(client, catalog, root, workers, offset)
        merge_manifest(root, offset, batch_size, results)
        if not args.until_end:
            break
        if len(catalog) < batch_size:
            print("本批不足一批，目录到头。", flush=True)
            break
        offset += len(catalog)
        print(f"\n—— 继续下一批 offset={offset} ——\n", flush=True)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        print("网络错误:", e, file=sys.stderr)
        sys.exit(1)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
