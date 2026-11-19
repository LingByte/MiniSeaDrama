"""Project paths, persisted settings and FFmpeg discovery."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent.parent.parent
SERVER_DIR = BASE_DIR / "server"
DATA_DIR = BASE_DIR / "data"
WORK_DIR = DATA_DIR / "works"
CACHE_DIR = DATA_DIR / "cache"
SETTINGS_PATH = DATA_DIR / "settings.json"
SKILL_PATH = BASE_DIR / "skills" / "至简海漫Skills_V1.4智能体版.md"
WEB_DIST = BASE_DIR / "web" / "dist"

# FFmpeg 是外部二进制，不放进仓库；这里列出本机上已有的两份，便于开箱即用。
LEGACY_FFMPEG_PATHS = (
    Path(r"E:\至简海漫\ShortFlix-v0.4.2-Windows-x64-最终版"
         r"\ShortFlix-Downloader-v0.4.2-Windows-x64\bin\ffmpeg.exe"),
    Path(r"E:\至简海漫\AsrTools-v1.1.0\AsrTools-v1.1.0\ffmpeg.exe"),
)


def ensure_dirs() -> None:
    for path in (DATA_DIR, WORK_DIR, CACHE_DIR):
        path.mkdir(parents=True, exist_ok=True)


def load_settings() -> Dict[str, object]:
    if not SETTINGS_PATH.is_file():
        return {}
    try:
        payload = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def save_settings(values: Dict[str, object]) -> Dict[str, object]:
    ensure_dirs()
    current = load_settings()
    for key, value in values.items():
        if value is None:
            continue
        current[key] = value
    temp_path = SETTINGS_PATH.with_name(SETTINGS_PATH.name + ".tmp")
    temp_path.write_text(
        json.dumps(current, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temp_path, SETTINGS_PATH)
    return current


def ffmpeg_candidates(explicit: Optional[str] = None) -> List[str]:
    saved = str(load_settings().get("ffmpeg_path") or "").strip()
    candidates = [
        (explicit or "").strip(),
        os.environ.get("MINISEA_FFMPEG", "").strip(),
        saved,
        str(BASE_DIR / "bin" / "ffmpeg.exe"),
        str(BASE_DIR / "bin" / "ffmpeg"),
        *(str(item) for item in LEGACY_FFMPEG_PATHS),
        shutil.which("ffmpeg") or "",
    ]
    return [item for item in candidates if item]


def find_ffmpeg(explicit: Optional[str] = None) -> str:
    for candidate in ffmpeg_candidates(explicit):
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return str(path.resolve())
    raise RuntimeError(
        "没有找到 FFmpeg。请把 ffmpeg.exe 放进项目 bin 目录，"
        "或在页面里填写 FFmpeg 的完整路径。"
    )


def safe_filename(value: str, fallback: str = "drama") -> str:
    invalid = '<>:"/\\|?*'
    cleaned = "".join("_" if ch in invalid or ord(ch) < 32 else ch for ch in (value or ""))
    cleaned = " ".join(cleaned.split()).strip(" .")
    return cleaned[:100] or fallback
