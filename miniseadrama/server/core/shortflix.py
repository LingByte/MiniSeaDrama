#!/usr/bin/env python3
"""ShortFlix episode discovery and download core.

This module intentionally uses only the Python standard library.  The actual
HLS remux is delegated to FFmpeg so video and audio can be copied without
quality loss.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from .cookies import parse_cookie_header


APP_VERSION = "0.4.2"
ALLOWED_HOSTS = {"shortflix.net", "www.shortflix.net"}
SERIES_MANIFEST_NAME = ".shortflix-series.json"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/150.0 Safari/537.36"
)
NEXT_CHUNK_RE = re.compile(
    r'self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)'
)
EPISODE_NUMBER_RE = re.compile(r"/episode-(\d+)(?:[/?#]|$)", re.IGNORECASE)
INVALID_FILENAME_RE = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')


class ShortFlixError(RuntimeError):
    """User-facing error raised by the downloader."""


class CancelledError(ShortFlixError):
    """Raised when the current job is cancelled."""


class AuthenticationRequired(ShortFlixError):
    """Raised when ShortFlix only returns guest-accessible episodes."""


@dataclass(frozen=True)
class Subtitle:
    title: str
    format: str
    url: str


@dataclass(frozen=True)
class EpisodeVersion:
    quality: str
    language: str
    video_url: str
    subtitles: Tuple[Subtitle, ...]
    hard_sub: bool = False


@dataclass(frozen=True)
class Episode:
    number: int
    title: str
    duration: int
    versions: Tuple[EpisodeVersion, ...]


@dataclass(frozen=True)
class Series:
    title: str
    slug: str
    source_url: str
    episodes: Tuple[Episode, ...]

    def to_dict(self) -> Dict[str, object]:
        return asdict(self)


def validate_shortflix_url(url: str) -> str:
    value = (url or "").strip()
    if not value:
        raise ShortFlixError("请粘贴 ShortFlix 剧目或剧集链接。")
    if "://" not in value:
        value = "https://" + value
    parsed = urllib.parse.urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or host not in ALLOWED_HOSTS:
        raise ShortFlixError("目前只支持 shortflix.net 的公开剧目或剧集链接。")
    if "/videos/" not in parsed.path:
        raise ShortFlixError(
            "这不是剧目链接。请先进入某部剧，再复制包含 /videos/ 的地址。"
        )
    return urllib.parse.urlunparse(
        ("https", "www.shortflix.net", parsed.path, "", "", "")
    )


def canonical_episode_url(url: str) -> str:
    normalized = validate_shortflix_url(url)
    parsed = urllib.parse.urlparse(normalized)
    parts = [part for part in parsed.path.split("/") if part]
    try:
        videos_index = parts.index("videos")
        slug = parts[videos_index + 1]
    except (ValueError, IndexError) as exc:
        raise ShortFlixError("无法从链接中识别剧目名称。") from exc
    return f"https://www.shortflix.net/videos/{slug}/episode-1"


def _decode_next_payload(page_html: str) -> str:
    chunks: List[str] = []
    for match in NEXT_CHUNK_RE.finditer(page_html):
        try:
            chunks.append(json.loads(match.group(1)))
        except json.JSONDecodeError:
            continue
    if not chunks:
        raise ShortFlixError("页面结构已变化：没有找到 ShortFlix 剧集数据。")
    return "".join(chunks)


def _find_series_object(payload: str) -> Dict[str, object]:
    decoder = json.JSONDecoder()
    cursor = 0
    marker = '"video":'
    candidates: List[Dict[str, object]] = []
    while True:
        index = payload.find(marker, cursor)
        if index < 0:
            break
        cursor = index + len(marker)
        try:
            candidate, _ = decoder.raw_decode(payload, cursor)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(candidate, dict)
            and isinstance(candidate.get("episodes"), list)
            and candidate.get("slug")
        ):
            candidates.append(candidate)
    if candidates:
        # Next.js may embed both small prefetch objects and the complete page
        # object.  The complete object is the one with the most episodes.
        return max(candidates, key=lambda item: len(item.get("episodes", [])))
    raise ShortFlixError("页面结构已变化：没有找到完整的剧目信息。")


def _quality_score(quality: str) -> int:
    match = re.search(r"(\d+)", quality or "")
    return int(match.group(1)) if match else 0


def _parse_subtitles(raw: object) -> Tuple[Subtitle, ...]:
    if not isinstance(raw, list):
        return ()
    result: List[Subtitle] = []
    seen = set()
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
        result.append(
            Subtitle(
                title=str(item.get("title") or "Subtitle"),
                format=str(item.get("format") or "VTT").upper(),
                url=url,
            )
        )
    return tuple(result)


def parse_series_html(page_html: str, source_url: str) -> Series:
    # The decoded Next.js chunks already contain valid JSON values.  Applying
    # HTML entity conversion here can alter text inside the object and make the
    # complete (larger) series object fail JSON decoding.
    payload = _decode_next_payload(page_html)
    raw_series = _find_series_object(payload)
    episodes: List[Episode] = []
    for raw_episode in raw_series.get("episodes", []):
        if not isinstance(raw_episode, dict):
            continue
        try:
            number = int(raw_episode.get("episodeNumber"))
        except (TypeError, ValueError):
            continue
        versions: List[EpisodeVersion] = []
        for raw_version in raw_episode.get("versions", []):
            if not isinstance(raw_version, dict):
                continue
            video_url = str(raw_version.get("videoUrl") or "").strip()
            if not video_url.startswith(("http://", "https://")):
                continue
            subtitles = _parse_subtitles(
                raw_version.get("subtitlesList") or raw_version.get("subtitles")
            )
            versions.append(
                EpisodeVersion(
                    quality=str(raw_version.get("quality") or "unknown"),
                    language=str(raw_version.get("lang") or "unknown"),
                    video_url=video_url,
                    subtitles=subtitles,
                    hard_sub=bool(raw_version.get("hardSub")),
                )
            )
        versions.sort(key=lambda item: _quality_score(item.quality), reverse=True)
        episodes.append(
            Episode(
                number=number,
                title=str(raw_episode.get("title") or f"Episode {number}"),
                duration=int(raw_episode.get("duration") or 0),
                versions=tuple(versions),
            )
        )
    episodes.sort(key=lambda item: item.number)
    if not episodes:
        raise ShortFlixError("该页面没有返回可下载的剧集。")
    return Series(
        title=str(raw_series.get("title") or raw_series.get("slug") or "ShortFlix"),
        slug=str(raw_series.get("slug") or "shortflix"),
        source_url=source_url,
        episodes=tuple(episodes),
    )


def fetch_text(
    url: str, timeout: int = 30, cookie_header: Optional[str] = None
) -> str:
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if cookie_header:
        headers["Cookie"] = cookie_header
    request = urllib.request.Request(
        url,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as exc:
        raise ShortFlixError(f"网站返回 HTTP {exc.code}，请稍后重试。") from exc
    except urllib.error.URLError as exc:
        raise ShortFlixError(
            f"无法连接 ShortFlix：{exc.reason}。如果网站只能通过 VPN 访问，"
            "请开启系统级或 TUN 模式；只代理 Chrome 的插件不会覆盖下载器。"
        ) from exc


def _episode_page_url(series: Series, episode_number: int) -> str:
    return (
        f"https://www.shortflix.net/videos/{series.slug}/"
        f"episode-{episode_number}"
    )


def _fetch_episode_page(
    series: Series,
    episode_number: int,
    timeout: int,
    cookie_header: Optional[str],
) -> Optional[Series]:
    url = _episode_page_url(series, episode_number)
    try:
        return parse_series_html(
            fetch_text(url, timeout=timeout, cookie_header=cookie_header), url
        )
    except ShortFlixError:
        return None


def discover_series(
    url: str,
    timeout: int = 30,
    workers: int = 6,
    cookie_header: Optional[str] = None,
) -> Series:
    source_url = canonical_episode_url(url)
    initial = parse_series_html(
        fetch_text(source_url, timeout=timeout, cookie_header=cookie_header),
        source_url,
    )
    merged: Dict[int, Episode] = {item.number: item for item in initial.episodes}
    missing = [item.number for item in initial.episodes if not item.versions]
    if missing and not cookie_header:
        available_count = len(initial.episodes) - len(missing)
        raise AuthenticationRequired(
            f"网站只向未登录访问返回 {available_count} 集，另有 "
            f"{len(missing)} 集需要登录。请先用 Chrome 小助手连接 "
            "ShortFlix 登录会话，再重新识别。"
        )
    if missing:
        with ThreadPoolExecutor(max_workers=max(1, min(workers, 8))) as executor:
            futures = {
                executor.submit(
                    _fetch_episode_page,
                    initial,
                    number,
                    timeout,
                    cookie_header,
                ): number
                for number in missing
            }
            for future in as_completed(futures):
                page_series = future.result()
                if not page_series:
                    continue
                for episode in page_series.episodes:
                    current = merged.get(episode.number)
                    if episode.versions and (current is None or not current.versions):
                        merged[episode.number] = episode
    available = tuple(
        item for _, item in sorted(merged.items()) if item.versions
    )
    if not available:
        raise ShortFlixError("该剧没有返回任何可下载的视频版本。")
    unresolved = [
        number for number, item in sorted(merged.items()) if not item.versions
    ]
    if unresolved:
        preview = "、".join(str(number) for number in unresolved[:12])
        suffix = "……" if len(unresolved) > 12 else ""
        raise ShortFlixError(
            f"登录会话没有解锁全部剧集，仍缺少 {len(unresolved)} 集"
            f"（{preview}{suffix}）。请在 ShortFlix 重新登录后再次连接。"
        )
    return Series(
        title=initial.title,
        slug=initial.slug,
        source_url=source_url,
        episodes=available,
    )


def safe_filename(value: str, fallback: str = "ShortFlix") -> str:
    cleaned = INVALID_FILENAME_RE.sub("_", (value or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned[:120] or fallback


def _read_series_manifest(directory: Path) -> Optional[Dict[str, object]]:
    manifest_path = directory / SERIES_MANIFEST_NAME
    if not manifest_path.is_file():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _write_series_manifest(directory: Path, series: Series) -> None:
    manifest_path = directory / SERIES_MANIFEST_NAME
    temp_path = manifest_path.with_name(manifest_path.name + ".tmp")
    payload = {
        "format_version": 1,
        "slug": series.slug,
        "title": series.title,
        "source_url": series.source_url,
    }
    try:
        temp_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temp_path, manifest_path)
    except OSError as exc:
        temp_path.unlink(missing_ok=True)
        raise ShortFlixError(f"无法保存剧目目录标识：{exc}") from exc


def series_output_directory(output_root: Path, series: Series) -> Path:
    """Resolve a stable, collision-safe directory while adopting legacy folders."""
    root = output_root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)

    # Reuse a previously identified directory even if the website later changes
    # the display title.
    try:
        existing_directories = [item for item in root.iterdir() if item.is_dir()]
    except OSError as exc:
        raise ShortFlixError(f"无法读取保存目录：{exc}") from exc
    for directory in existing_directories:
        manifest = _read_series_manifest(directory)
        if manifest and str(manifest.get("slug") or "") == series.slug:
            return directory

    legacy_directory = root / safe_filename(series.title)
    if not legacy_directory.exists():
        legacy_directory.mkdir(parents=True, exist_ok=True)
        _write_series_manifest(legacy_directory, series)
        return legacy_directory

    legacy_manifest = _read_series_manifest(legacy_directory)
    if not legacy_manifest:
        # v0.4.1 and earlier used title-only folders.  The first matching drama
        # after upgrade adopts that folder so completed episodes are not redownloaded.
        _write_series_manifest(legacy_directory, series)
        return legacy_directory
    if str(legacy_manifest.get("slug") or "") == series.slug:
        return legacy_directory

    slug_suffix = safe_filename(series.slug, "series")
    isolated_directory = root / f"{safe_filename(series.title)} [{slug_suffix}]"
    isolated_manifest = _read_series_manifest(isolated_directory)
    if isolated_directory.exists() and isolated_manifest:
        existing_slug = str(isolated_manifest.get("slug") or "")
        if existing_slug and existing_slug != series.slug:
            raise ShortFlixError(
                "保存目录中存在冲突的剧目标识，请换一个保存目录后重试。"
            )
    isolated_directory.mkdir(parents=True, exist_ok=True)
    _write_series_manifest(isolated_directory, series)
    return isolated_directory


def find_ffmpeg(explicit: Optional[str] = None) -> str:
    """项目内的 FFmpeg 定位统一交给 settings 处理。"""
    from .settings import find_ffmpeg as resolve

    try:
        return resolve(explicit)
    except RuntimeError as exc:
        raise ShortFlixError(str(exc)) from exc


def select_version(
    episode: Episode,
    quality: Optional[str] = None,
    language: Optional[str] = None,
) -> EpisodeVersion:
    versions: Sequence[EpisodeVersion] = episode.versions
    if language:
        language_matches = [
            item for item in versions if item.language.lower() == language.lower()
        ]
        if language_matches:
            versions = language_matches
    if quality and quality.lower() != "best":
        quality_matches = [
            item for item in versions if item.quality.lower() == quality.lower()
        ]
        if quality_matches:
            versions = quality_matches
    if not versions:
        raise ShortFlixError(f"第 {episode.number} 集没有可用的视频版本。")
    return max(versions, key=lambda item: _quality_score(item.quality))


def download_text_file(
    url: str,
    destination: Path,
    timeout: int = 30,
    cookie_header: Optional[str] = None,
) -> None:
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": "https://www.shortflix.net/",
    }
    if cookie_header:
        headers["Cookie"] = cookie_header
    request = urllib.request.Request(url, headers=headers)
    temp_path = destination.with_suffix(destination.suffix + ".part")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            temp_path.write_bytes(response.read())
        temp_path.replace(destination)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


ProgressCallback = Callable[[Dict[str, object]], None]


def media_process_environment() -> Dict[str, str]:
    """Pass OS/browser-independent proxy settings through to FFmpeg."""
    environment = os.environ.copy()
    for scheme, proxy_url in urllib.request.getproxies().items():
        if scheme.lower() in {"http", "https"} and proxy_url:
            environment.setdefault(f"{scheme.lower()}_proxy", proxy_url)
    return environment


def media_url_looks_expired(detail: str) -> bool:
    return bool(
        re.search(
            r"(?:HTTP error 40[13]|403 Forbidden|401 Unauthorized|"
            r"AccessDenied|ExpiredToken|SignatureDoesNotMatch|"
            r"signature (?:has )?expired)",
            detail or "",
            flags=re.IGNORECASE,
        )
    )


class SeriesDownloader:
    def __init__(
        self,
        ffmpeg_path: Optional[str] = None,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> None:
        self.ffmpeg_path = find_ffmpeg(ffmpeg_path)
        self.progress_callback = progress_callback or (lambda _event: None)
        self.process_environment = media_process_environment()
        self.cancel_event = threading.Event()
        self._process_lock = threading.Lock()
        self._process: Optional[subprocess.Popen[str]] = None

    def cancel(self) -> None:
        self.cancel_event.set()
        with self._process_lock:
            if self._process and self._process.poll() is None:
                self._process.terminate()

    def _emit(self, **event: object) -> None:
        self.progress_callback(event)

    def _wait_retry(self, seconds: float) -> None:
        if self.cancel_event.wait(max(0.0, seconds)):
            raise CancelledError("下载已停止。")

    @staticmethod
    def _verification_timeout(path: Path, expected_duration: int = 0) -> int:
        try:
            size_megabytes = path.stat().st_size / (1024 * 1024)
        except OSError:
            size_megabytes = 0
        return int(
            min(
                1800,
                max(
                    180,
                    max(0, expected_duration) * 4,
                    size_megabytes * 2,
                ),
            )
        )

    def _run_capture(
        self,
        command: Sequence[str],
        timeout: int,
    ) -> Tuple[int, str, bool]:
        try:
            process = subprocess.Popen(
                list(command),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                env=self.process_environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            return -1, str(exc), False
        with self._process_lock:
            self._process = process
        deadline = time.monotonic() + max(1, timeout)
        timed_out = False
        stderr = ""
        try:
            while True:
                if self.cancel_event.is_set():
                    process.terminate()
                    try:
                        process.communicate(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
                    raise CancelledError("下载已停止。")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    process.kill()
                    _, stderr = process.communicate()
                    break
                try:
                    _, stderr = process.communicate(timeout=min(0.25, remaining))
                    if self.cancel_event.is_set():
                        raise CancelledError("下载已停止。")
                    break
                except subprocess.TimeoutExpired:
                    continue
        finally:
            with self._process_lock:
                if self._process is process:
                    self._process = None
        return process.returncode or 0, stderr or "", timed_out

    def _verify_media(
        self,
        path: Path,
        expected_duration: int = 0,
        timeout: Optional[int] = None,
    ) -> Tuple[bool, str]:
        """Decode the finished file to catch truncated or corrupt MP4 output."""
        effective_timeout = (
            max(1, timeout)
            if timeout is not None
            else self._verification_timeout(path, expected_duration)
        )
        command = [
            self.ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-f",
            "null",
            "-",
        ]
        return_code, stderr, timed_out = self._run_capture(
            command,
            effective_timeout,
        )
        if timed_out:
            return False, f"完整解码校验超过 {effective_timeout} 秒"
        if return_code == 0:
            return True, ""
        detail = stderr or "FFmpeg 校验失败"
        if return_code == -1:
            detail = f"无法启动 FFmpeg 校验：{detail}"
        return False, detail[-500:].strip()

    def _probe_resolution(self, path: Path, timeout: int = 30) -> Optional[Tuple[int, int]]:
        """Return the first video stream resolution without requiring ffprobe."""
        command = [
            self.ffmpeg_path,
            "-hide_banner",
            "-i",
            str(path),
        ]
        _, stderr, timed_out = self._run_capture(command, timeout)
        if timed_out:
            return None
        match = re.search(
            r"Video:.*?[, ](\d{2,5})x(\d{2,5})(?:[ ,\[])", stderr
        )
        if not match:
            return None
        return int(match.group(1)), int(match.group(2))

    def _emit_quality_warning(
        self,
        episode: Episode,
        version: EpisodeVersion,
        path: Path,
        overall_index: int,
        overall_total: int,
    ) -> None:
        resolution = self._probe_resolution(path)
        expected_edge = _quality_score(version.quality)
        if (
            not resolution
            or expected_edge < 360
            or min(resolution) >= expected_edge * 0.75
        ):
            return
        width, height = resolution
        self._emit(
            type="quality_warning",
            episode=episode.number,
            index=overall_index,
            total=overall_total,
            expected_quality=version.quality,
            resolution=f"{width}×{height}",
            message=(
                f"第 {episode.number} 集网站标注 {version.quality}，"
                f"但媒体线路实际为 {width}×{height}"
            ),
        )

    @staticmethod
    def _move_corrupt_file(path: Path) -> Path:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        candidate = path.with_name(f"{path.stem}.corrupt-{stamp}{path.suffix}")
        counter = 2
        while candidate.exists():
            candidate = path.with_name(
                f"{path.stem}.corrupt-{stamp}-{counter}{path.suffix}"
            )
            counter += 1
        path.replace(candidate)
        return candidate

    def _download_episode(
        self,
        series: Series,
        episode: Episode,
        version: EpisodeVersion,
        destination: Path,
        overall_index: int,
        overall_total: int,
        retries: int,
        refresh_version: Optional[Callable[[], EpisodeVersion]] = None,
    ) -> EpisodeVersion:
        current_version = version
        if destination.exists() and destination.stat().st_size > 0:
            self._emit(
                type="episode_verifying",
                episode=episode.number,
                index=overall_index,
                total=overall_total,
                path=str(destination),
                message=f"正在校验已存在的第 {episode.number} 集",
            )
            valid, detail = self._verify_media(
                destination,
                expected_duration=episode.duration,
            )
            if valid:
                self._emit_quality_warning(
                    episode,
                    current_version,
                    destination,
                    overall_index,
                    overall_total,
                )
                self._emit(
                    type="episode_skipped",
                    episode=episode.number,
                    index=overall_index,
                    total=overall_total,
                    path=str(destination),
                    message="文件已存在且校验通过，已跳过",
                )
                return current_version
            corrupt_path = self._move_corrupt_file(destination)
            self._emit(
                type="episode_corrupt",
                episode=episode.number,
                index=overall_index,
                total=overall_total,
                path=str(corrupt_path),
                message=f"旧文件损坏，已保留备份并重新下载：{detail}",
            )
        temp_path = destination.with_suffix(".part.mp4")
        temp_path.unlink(missing_ok=True)
        attempts = max(1, retries + 1)
        for attempt in range(1, attempts + 1):
            if self.cancel_event.is_set():
                raise CancelledError("下载已停止。")
            command = [
                self.ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                current_version.video_url,
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-progress",
                "pipe:1",
                "-nostats",
                str(temp_path),
            ]
            self._emit(
                type="episode_started",
                episode=episode.number,
                index=overall_index,
                total=overall_total,
                attempt=attempt,
                message=f"正在下载第 {episode.number} 集",
            )
            try:
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                    env=self.process_environment,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except OSError as exc:
                raise ShortFlixError(f"无法启动 FFmpeg：{exc}") from exc
            with self._process_lock:
                self._process = process
            stderr_tail: deque[str] = deque(maxlen=120)
            stderr_thread: Optional[threading.Thread] = None
            if process.stderr is not None:
                def drain_stderr(
                    stream: object = process.stderr,
                ) -> None:
                    assert hasattr(stream, "__iter__")
                    for stderr_line in stream:
                        stderr_tail.append(stderr_line)

                stderr_thread = threading.Thread(
                    target=drain_stderr,
                    name="shortflix-ffmpeg-stderr",
                    daemon=True,
                )
                stderr_thread.start()
            assert process.stdout is not None
            for line in process.stdout:
                if self.cancel_event.is_set():
                    process.terminate()
                    break
                key, _, value = line.strip().partition("=")
                if key in {"out_time_ms", "out_time_us"}:
                    try:
                        seconds = int(value) / 1_000_000
                    except ValueError:
                        continue
                    percent = (
                        min(99.0, seconds / episode.duration * 100)
                        if episode.duration
                        else 0.0
                    )
                    self._emit(
                        type="episode_progress",
                        episode=episode.number,
                        index=overall_index,
                        total=overall_total,
                        percent=round(percent, 1),
                        seconds=round(seconds, 1),
                        duration=episode.duration,
                    )
            return_code = process.wait()
            if stderr_thread:
                stderr_thread.join(timeout=2)
            stderr = "".join(stderr_tail).strip()
            with self._process_lock:
                self._process = None
            if self.cancel_event.is_set():
                temp_path.unlink(missing_ok=True)
                raise CancelledError("下载已停止。")
            if return_code == 0 and temp_path.exists() and temp_path.stat().st_size:
                self._emit(
                    type="episode_verifying",
                    episode=episode.number,
                    index=overall_index,
                    total=overall_total,
                    path=str(temp_path),
                    message=f"正在校验第 {episode.number} 集完整性",
                )
                try:
                    valid, detail = self._verify_media(
                        temp_path,
                        expected_duration=episode.duration,
                    )
                except CancelledError:
                    temp_path.unlink(missing_ok=True)
                    raise
                if not valid:
                    temp_path.unlink(missing_ok=True)
                    if attempt < attempts:
                        self._emit(
                            type="episode_retry",
                            episode=episode.number,
                            index=overall_index,
                            total=overall_total,
                            attempt=attempt + 1,
                            message=f"第 {episode.number} 集校验失败，准备重试",
                        )
                        self._wait_retry(min(2 * attempt, 5))
                        continue
                    raise ShortFlixError(
                        f"第 {episode.number} 集下载后校验失败：{detail}"
                    )
                try:
                    self._emit_quality_warning(
                        episode,
                        current_version,
                        temp_path,
                        overall_index,
                        overall_total,
                    )
                except CancelledError:
                    temp_path.unlink(missing_ok=True)
                    raise
                temp_path.replace(destination)
                self._emit(
                    type="episode_completed",
                    episode=episode.number,
                    index=overall_index,
                    total=overall_total,
                    path=str(destination),
                    size=destination.stat().st_size,
                    message=f"第 {episode.number} 集完成",
                )
                return current_version
            temp_path.unlink(missing_ok=True)
            expired_media_url = media_url_looks_expired(stderr)
            if expired_media_url and refresh_version and attempt < attempts:
                current_version = refresh_version()
                self._emit(
                    type="media_url_refreshed",
                    episode=episode.number,
                    index=overall_index,
                    total=overall_total,
                    message=f"第 {episode.number} 集媒体链接已刷新，准备重试",
                )
                self._wait_retry(min(attempt, 2))
                continue
            if attempt < attempts:
                self._emit(
                    type="episode_retry",
                    episode=episode.number,
                    index=overall_index,
                    total=overall_total,
                    attempt=attempt + 1,
                    message=f"第 {episode.number} 集失败，准备重试",
                )
                self._wait_retry(min(2 * attempt, 5))
                continue
            detail = stderr[-500:] if stderr else f"FFmpeg 退出码 {return_code}"
            raise ShortFlixError(f"第 {episode.number} 集下载失败：{detail}")

    def download(
        self,
        series: Series,
        output_root: Path,
        episode_numbers: Optional[Iterable[int]] = None,
        quality: Optional[str] = "best",
        language: Optional[str] = None,
        subtitles: bool = True,
        retries: int = 2,
        series_refresher: Optional[Callable[[], Series]] = None,
    ) -> Path:
        selected = set(episode_numbers or [])
        episodes = [
            item for item in series.episodes if not selected or item.number in selected
        ]
        if not episodes:
            raise ShortFlixError("没有选择任何可下载剧集。")
        series_dir = series_output_directory(output_root, series)
        total = len(episodes)
        for index, episode in enumerate(episodes, start=1):
            version = select_version(episode, quality=quality, language=language)

            def refresh_current_version() -> EpisodeVersion:
                if not series_refresher:
                    return version
                fresh_series = series_refresher()
                if fresh_series.slug != series.slug:
                    raise ShortFlixError("网站返回了不同的剧目，已停止以保护文件。")
                fresh_episode = next(
                    (
                        item
                        for item in fresh_series.episodes
                        if item.number == episode.number
                    ),
                    None,
                )
                if fresh_episode is None:
                    raise ShortFlixError(
                        f"刷新媒体链接后找不到第 {episode.number} 集。"
                    )
                return select_version(
                    fresh_episode,
                    quality=quality,
                    language=language,
                )

            filename = f"{safe_filename(series.title)} - E{episode.number:03d}.mp4"
            destination = series_dir / filename
            downloaded_version = self._download_episode(
                series,
                episode,
                version,
                destination,
                index,
                total,
                retries,
                refresh_version=(
                    refresh_current_version if series_refresher else None
                ),
            )
            if subtitles:
                for subtitle_index, subtitle in enumerate(
                    downloaded_version.subtitles,
                    start=1,
                ):
                    extension = subtitle.format.lower()
                    suffix = (
                        f".{version.language}.{extension}"
                        if subtitle_index == 1
                        else f".{version.language}.{subtitle_index}.{extension}"
                    )
                    subtitle_path = destination.with_suffix(suffix)
                    if not subtitle_path.exists():
                        try:
                            download_text_file(subtitle.url, subtitle_path)
                        except Exception as first_exc:
                            try:
                                refreshed_version = refresh_current_version()
                                refreshed_subtitle = (
                                    refreshed_version.subtitles[subtitle_index - 1]
                                    if len(refreshed_version.subtitles)
                                    >= subtitle_index
                                    else None
                                )
                                if refreshed_subtitle is None:
                                    raise first_exc
                                download_text_file(
                                    refreshed_subtitle.url,
                                    subtitle_path,
                                )
                            except Exception as exc:
                                self._emit(
                                    type="subtitle_warning",
                                    episode=episode.number,
                                    message=f"字幕下载失败：{exc}",
                                )
        return series_dir
