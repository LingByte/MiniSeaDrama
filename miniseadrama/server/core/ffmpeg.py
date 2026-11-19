"""Thin FFmpeg helpers shared by the downloader and the ASR stage."""

from __future__ import annotations

import re
import subprocess
import threading
from pathlib import Path
from typing import Optional, Sequence, Tuple

from .settings import find_ffmpeg

DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


class MediaCancelled(RuntimeError):
    """Raised when the user cancels a media command."""


def resolve_ffmpeg(explicit: Optional[str] = None) -> str:
    return find_ffmpeg(explicit)


def run_ffmpeg(
    ffmpeg_path: str,
    args: Sequence[str],
    timeout: int = 1800,
    cancel_event: Optional[threading.Event] = None,
) -> Tuple[int, str]:
    """Run FFmpeg and return (returncode, stderr)."""
    command = [ffmpeg_path, "-hide_banner", "-y", *args]
    process = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                process.terminate()
                try:
                    process.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise MediaCancelled("任务已取消。")
            try:
                _, stderr = process.communicate(timeout=0.25)
                return process.returncode or 0, stderr or ""
            except subprocess.TimeoutExpired:
                continue
    finally:
        if process.poll() is None:
            process.kill()


def probe_duration(ffmpeg_path: str, media_path: Path, timeout: int = 60) -> int:
    """Return media duration in milliseconds using FFmpeg's banner output."""
    result = subprocess.run(
        [ffmpeg_path, "-hide_banner", "-i", str(media_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    match = DURATION_RE.search(result.stderr or "")
    if not match:
        return 0
    hours, minutes, seconds = match.groups()
    total = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return int(total * 1000)


def extract_audio(
    ffmpeg_path: str,
    video_path: Path,
    audio_path: Path,
    cancel_event: Optional[threading.Event] = None,
) -> Path:
    """Extract a mono 16 kHz MP3, which every ASR engine accepts."""
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    code, stderr = run_ffmpeg(
        ffmpeg_path,
        [
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "64k",
            "-f",
            "mp3",
            str(audio_path),
        ],
        cancel_event=cancel_event,
    )
    if code != 0 or not audio_path.is_file() or audio_path.stat().st_size == 0:
        detail = (stderr or "").strip()[-500:]
        raise RuntimeError(f"音频提取失败：{detail}")
    return audio_path
