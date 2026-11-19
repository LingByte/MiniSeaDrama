"""End-to-end pipeline: inspect -> download -> ASR -> merge -> script."""

from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import asr
from .cookies import parse_cookie_header
from .ffmpeg import extract_audio, probe_duration, resolve_ffmpeg
from .script import LLMClient, LLMConfig, ScriptGenerator
from .settings import SKILL_PATH, WORK_DIR, safe_filename
from .shortflix import (
    CancelledError,
    Series,
    SeriesDownloader,
    discover_series,
    download_text_file,
)
from .subtitles import (
    Segment,
    dedupe_segments,
    looks_english,
    offset_segments,
    parse_subtitle_file,
    segments_to_paragraphs,
    segments_to_srt,
    subtitle_title_is_english,
    subtitle_title_is_other_language,
)

Emit = Callable[..., None]

STAGE_LABELS = {
    "inspect": "识别剧集",
    "download": "下载素材",
    "transcribe": "字幕准备",
    "merge": "合并全剧字幕",
    "script": "生成剧本",
    "done": "完成",
}

STAGE_WEIGHTS = {
    "inspect": 3,
    "download": 37,
    "transcribe": 38,
    "merge": 5,
    "script": 17,
}
STAGE_ORDER = ["inspect", "download", "transcribe", "merge", "script"]


class PipelineCancelled(RuntimeError):
    """Raised when the job is cancelled by the user."""


class Pipeline:
    def __init__(
        self,
        params: Dict[str, Any],
        emit: Emit,
        cancel_event: threading.Event,
        pause_event: Optional[threading.Event] = None,
    ):
        self.params = params
        self.emit = emit
        self.cancel_event = cancel_event
        self.pause_event = pause_event or threading.Event()
        self.downloader: Optional[SeriesDownloader] = None
        self.state: Dict[str, Any] = {
            "stage": "inspect",
            "stage_label": STAGE_LABELS["inspect"],
            "overall": 0,
            "total_episodes": 0,
            "downloaded": 0,
            "transcribed": 0,
            "current_episode": None,
            "script_batch": 0,
            "script_batches": 0,
        }
        self._lock = threading.Lock()

    # ---------- helpers ----------

    def check_cancel(self) -> None:
        if self.cancel_event.is_set():
            raise PipelineCancelled("任务已取消。")

    def wait_if_paused(self) -> None:
        """在安全点阻塞，直到用户点击继续或取消。"""
        if not self.pause_event.is_set():
            return
        self.emit("log", "任务已暂停，等待继续。")
        while self.pause_event.is_set():
            self.check_cancel()
            time.sleep(0.5)
        self.emit("log", "已继续执行。")

    def _fraction(self, stage: str, ratio: float) -> float:
        if stage == "done":
            return 100.0
        base = 0.0
        for key in STAGE_ORDER:
            if key == stage:
                break
            base += STAGE_WEIGHTS[key]
        ratio = max(0.0, min(1.0, ratio))
        return round(base + STAGE_WEIGHTS[stage] * ratio, 1)

    def _progress(
        self,
        stage: str,
        ratio: float,
        message: str,
        **extra: Any,
    ) -> None:
        with self._lock:
            self.state["stage"] = stage
            self.state["stage_label"] = STAGE_LABELS[stage]
            self.state["overall"] = self._fraction(stage, ratio)
            for key, value in extra.items():
                self.state[key] = value
            snapshot = dict(self.state)
        self.emit("progress", message, progress=snapshot, **extra)

    # ---------- main ----------

    def run(self) -> Dict[str, Any]:
        self.check_cancel()
        cookie_header = parse_cookie_header(str(self.params.get("cookie") or ""))
        url = str(self.params.get("url") or "").strip()

        self._progress("inspect", 0.1, "正在识别剧目信息。")
        series = discover_series(url, cookie_header=cookie_header or None)
        self.check_cancel()
        self.emit(
            "series",
            f"已识别《{series.title}》，共 {len(series.episodes)} 集。",
            series={
                "title": series.title,
                "slug": series.slug,
                "source_url": series.source_url,
                "episode_count": len(series.episodes),
                "episodes": [
                    {
                        "number": episode.number,
                        "title": episode.title,
                        "duration": episode.duration,
                    }
                    for episode in series.episodes
                ],
            },
        )
        self._progress(
            "inspect",
            1.0,
            "剧目识别完成。",
            total_episodes=len(series.episodes),
        )

        workdir = self._workdir(series)
        self.check_cancel()
        self.wait_if_paused()

        series_dir: Optional[Path] = None
        ffmpeg_path: Optional[str] = None
        srt_paths: Dict[int, Path] = {}
        try:
            srt_paths = self._fetch_english_subtitles(series, workdir, cookie_header)
        except RuntimeError as exc:
            self.emit("log", f"{exc} 将改用视频语音识别补全字幕。")

        missing = [
            episode.number
            for episode in series.episodes
            if episode.number not in srt_paths
        ]
        if missing:
            self.check_cancel()
            self.wait_if_paused()
            audio_dir = workdir / "audio"
            no_audio = [
                number
                for number in missing
                if not (audio_dir / f"E{number:03d}.mp3").is_file()
            ]
            if no_audio:
                ffmpeg_path = resolve_ffmpeg(self.params.get("ffmpeg"))
                series_dir = self._download(
                    series,
                    workdir / "videos",
                    cookie_header,
                    ffmpeg_path,
                    no_audio,
                )
                self.check_cancel()
            srt_paths.update(
                self._transcribe(series, series_dir, workdir, ffmpeg_path)
            )
        self.check_cancel()
        self.wait_if_paused()

        merge_result = self._merge(
            series, workdir, series_dir, srt_paths, ffmpeg_path
        )
        return self._finish(series, workdir, merge_result)

    def _finish(
        self,
        series: Series,
        workdir: Path,
        merge_result: Dict[str, Any],
    ) -> Dict[str, Any]:
        artifacts = list(merge_result["artifacts"])
        script_result: Optional[Dict[str, Any]] = None
        script_error: Optional[str] = None
        llm_config = self.params.get("llm") or {}
        if str(llm_config.get("api_key") or "").strip():
            self._progress("script", 0.02, "正在生成剧本。")
            try:
                client = LLMClient(LLMConfig(**self._llm_kwargs(llm_config)))
                skill = SKILL_PATH.read_text(encoding="utf-8")
                generator = ScriptGenerator(
                    client,
                    skill,
                    self._script_emit,
                    batch_size=int(self.params.get("batch_size") or 3),
                    wait=self.wait_if_paused,
                )
                script_result = generator.generate(workdir, merge_result["transcript"])
                artifacts.extend(
                    [
                        {"key": "script_docx", "label": "剧本.docx", "path": script_result["script_docx"]},
                        {"key": "setting_docx", "label": "设定.docx", "path": script_result["setting_docx"]},
                        {"key": "plan_json", "label": "策划方案 plan.json", "path": script_result["plan_json"]},
                        {"key": "meta_json", "label": "设定要点.json", "path": script_result["meta_json"]},
                    ]
                )
            except Exception as exc:
                script_error = str(exc) or exc.__class__.__name__
                self.emit(
                    "log",
                    f"剧本生成失败，已保留字幕与提示词包：{script_error}",
                )
        else:
            self.emit("log", "未填写模型 API Key，本次只产出提示词包与合并字幕。")

        self._progress("done", 1.0, "全流程完成。")
        return {
            "workdir": str(workdir),
            "series": {
                "title": series.title,
                "slug": series.slug,
                "source_url": series.source_url,
                "episode_count": len(series.episodes),
            },
            "transcript_txt": merge_result["transcript_path"],
            "series_srt": merge_result["srt_path"],
            "prompt_bundle": merge_result["prompt_path"],
            "episodes_json": merge_result["episodes_json"],
            "script": script_result,
            "script_error": script_error,
            "meta": (script_result or {}).get("meta"),
            "artifacts": artifacts,
        }

    # ---------- stages ----------

    def _workdir(self, series: Series) -> Path:
        root = Path(str(self.params.get("output_root") or WORK_DIR)).expanduser()
        folder = f"{safe_filename(series.title)} [{safe_filename(series.slug)}]"
        workdir = root / folder
        for name in ("videos", "audio", "subtitles", "text", "series", "prompt", "output"):
            (workdir / name).mkdir(parents=True, exist_ok=True)
        return workdir

    def _fetch_english_subtitles(
        self,
        series: Series,
        workdir: Path,
        cookie_header: str,
    ) -> Dict[int, Path]:
        """Download only official English subtitle tracks; no video, no ASR."""
        subs_dir = workdir / "subtitles"
        subs_dir.mkdir(parents=True, exist_ok=True)
        total = len(series.episodes)
        paths: Dict[int, Path] = {}
        missing: List[int] = []

        self._progress("download", 0.0, "正在获取官方英文字幕。", downloaded=0)
        for index, episode in enumerate(series.episodes, 1):
            self.check_cancel()
            self._progress(
                "download",
                (index - 1) / total if total else 0,
                f"正在获取第 {episode.number} 集字幕。",
                current_episode=episode.number,
                downloaded=index - 1,
            )
            saved: Optional[Path] = None
            for subtitle in self._english_subtitle_candidates(episode):
                suffix = ".vtt" if "VTT" in subtitle.format.upper() else ".srt"
                target = subs_dir / f"E{episode.number:03d}{suffix}"
                content: Optional[str] = None
                for attempt in (1, 2):
                    try:
                        download_text_file(
                            subtitle.url,
                            target,
                            cookie_header=cookie_header or None,
                        )
                        content = target.read_text(encoding="utf-8", errors="replace")
                        break
                    except Exception as exc:
                        target.unlink(missing_ok=True)
                        if attempt == 1:
                            time.sleep(1.0)
                            continue
                        self.emit(
                            "log", f"第 {episode.number} 集字幕下载失败：{exc}"
                        )
                if content and looks_english(content):
                    saved = target
                    break
                target.unlink(missing_ok=True)

            if saved:
                paths[episode.number] = saved
            else:
                missing.append(episode.number)
            self._progress(
                "download",
                index / total if total else 1,
                f"第 {episode.number} 集字幕处理完成。",
                current_episode=episode.number,
                downloaded=index,
            )

        if not paths:
            hard_sub_episodes = [
                episode.number
                for episode in series.episodes
                if episode.versions
                and all(version.hard_sub for version in episode.versions)
            ]
            if len(hard_sub_episodes) == len(series.episodes):
                raise RuntimeError(
                    f"《{series.title}》全部 {len(series.episodes)} 集都是硬字幕："
                    "网站没有提供可下载的字幕文件。"
                )
            raise RuntimeError(
                f"整剧 {len(series.episodes)} 集都没有可下载的英文字幕轨。"
            )
        if missing:
            preview = "、".join(str(item) for item in missing[:10])
            self.emit(
                "log",
                f"有 {len(missing)} 集没有英文字幕，已跳过：{preview}"
                + ("…" if len(missing) > 10 else ""),
            )
        self._progress(
            "transcribe",
            1.0,
            "已使用官方英文字幕，跳过 ASR。",
            transcribed=len(paths),
        )
        return paths

    @staticmethod
    def _english_subtitle_candidates(episode: Any) -> List[Any]:
        seen = set()
        scored: List[tuple[int, Any]] = []
        for version in episode.versions:
            for subtitle in version.subtitles:
                if subtitle.url in seen:
                    continue
                seen.add(subtitle.url)
                if subtitle_title_is_other_language(subtitle.title):
                    continue
                score = 2 if subtitle_title_is_english(subtitle.title) else 1
                scored.append((score, subtitle))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [item[1] for item in scored]

    def _download(
        self,
        series: Series,
        videos_root: Path,
        cookie_header: str,
        ffmpeg_path: str,
        episode_numbers: Optional[List[int]] = None,
    ) -> Path:
        self._progress("download", 0.0, "正在下载需要补字幕的剧集。")

        def on_event(event: Dict[str, Any]) -> None:
            if self.cancel_event.is_set() and self.downloader:
                self.downloader.cancel()
            event_type = str(event.get("type") or "")
            episode = event.get("episode")
            completed = int(event.get("index") or 0)
            total = int(event.get("total") or len(series.episodes) or 1)
            if event_type == "episode_progress":
                percent = float(event.get("percent") or 0)
                ratio = ((max(0, completed - 1) + percent / 100) / total) if total else 0
                self._progress(
                    "download",
                    ratio,
                    f"正在下载第 {episode} 集（{percent:.0f}%）。",
                    current_episode=episode,
                    downloaded=completed - 1,
                )
                return
            if event_type in {"episode_completed", "episode_skipped"}:
                self.wait_if_paused()
                self._progress(
                    "download",
                    completed / total if total else 0,
                    f"第 {episode} 集下载完成。",
                    current_episode=episode,
                    downloaded=completed,
                )
                return
            message = str(event.get("message") or "")
            if message:
                self.emit("log", message)

        self.downloader = SeriesDownloader(
            ffmpeg_path=ffmpeg_path,
            progress_callback=on_event,
        )

        def refresh() -> Series:
            return discover_series(
                series.source_url,
                cookie_header=cookie_header or None,
            )

        try:
            series_dir = self.downloader.download(
                series,
                videos_root,
                episode_numbers=episode_numbers,
                subtitles=False,
                retries=2,
                series_refresher=refresh,
            )
        except CancelledError as exc:
            raise PipelineCancelled(str(exc)) from exc
        finally:
            self.downloader = None
        self._progress(
            "download",
            1.0,
            f"下载完成：{series_dir}",
            downloaded=len(series.episodes),
        )
        return series_dir

    def _find_video(self, series_dir: Path, series: Series, number: int) -> Optional[Path]:
        expected = series_dir / f"{safe_filename(series.title)} - E{number:03d}.mp4"
        if expected.is_file():
            return expected
        matches = sorted(series_dir.glob(f"*E{number:03d}*.mp4"))
        return matches[0] if matches else None

    def _transcribe(
        self,
        series: Series,
        series_dir: Optional[Path],
        workdir: Path,
        ffmpeg_path: Optional[str],
    ) -> Dict[int, Path]:
        engine = str(self.params.get("engine") or asr.DEFAULT_ENGINE)
        workers = max(1, min(6, int(self.params.get("workers") or 3)))
        force = bool(self.params.get("redo_asr"))
        total = len(series.episodes)
        srt_dir = workdir / "subtitles"
        audio_dir = workdir / "audio"
        text_dir = workdir / "text"

        self._progress("transcribe", 0.0, "开始逐集提取语音并识别。", transcribed=0)
        results: Dict[int, Path] = {}
        failures: List[str] = []
        counter = {"done": 0}

        def work(episode: Any) -> Optional[Path]:
            number = episode.number
            self.check_cancel()
            self.wait_if_paused()
            srt_path = srt_dir / f"E{number:03d}.srt"
            vtt_path = srt_dir / f"E{number:03d}.vtt"
            existing: Optional[Path] = None
            if vtt_path.is_file() and vtt_path.stat().st_size > 0 and not force:
                existing = vtt_path
            elif srt_path.is_file() and srt_path.stat().st_size > 0 and not force:
                existing = srt_path
            if existing:
                # 复用已有字幕时也刷新逐集文本
                (text_dir / f"E{number:03d}.txt").write_text(
                    segments_to_paragraphs(
                        dedupe_segments(parse_subtitle_file(existing))
                    ),
                    encoding="utf-8",
                )
                return existing
            audio_path = audio_dir / f"E{number:03d}.mp3"
            if not audio_path.is_file() or audio_path.stat().st_size == 0:
                if series_dir is None or not ffmpeg_path:
                    raise RuntimeError(f"第 {number} 集缺少音频，且没有视频可提取。")
                video = self._find_video(series_dir, series, number)
                if not video:
                    raise RuntimeError(f"第 {number} 集视频文件不存在。")
                self.emit("log", f"第 {number} 集：提取音频。")
                extract_audio(
                    ffmpeg_path,
                    video,
                    audio_path,
                    cancel_event=self.cancel_event,
                )
            self.check_cancel()
            result = None
            errors: List[str] = []
            for name in [engine] + [key for key in asr.ENGINES if key != engine]:
                try:
                    candidate = asr.transcribe(
                        str(audio_path),
                        engine=name,
                        use_cache=True,
                        retries=2,
                        progress=lambda message: self.emit(
                            "log", f"第 {number} 集：{message}"
                        ),
                    )
                except Exception as exc:
                    errors.append(f"{asr.ENGINES[name][0]}：{exc}")
                    continue
                if candidate.has_data():
                    result = candidate
                    break
                errors.append(f"{asr.ENGINES[name][0]}：没有识别出文字")
            if result is None:
                raise RuntimeError("；".join(errors[-2:]))
            segments = [
                Segment(
                    int(float(item.start_time)),
                    int(float(item.end_time)),
                    item.text,
                )
                for item in result
            ]
            cleaned = dedupe_segments(segments)
            srt_path.write_text(
                segments_to_srt(cleaned),
                encoding="utf-8",
            )
            (text_dir / f"E{number:03d}.txt").write_text(
                segments_to_paragraphs(cleaned),
                encoding="utf-8",
            )
            return srt_path

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(work, episode): episode.number
                for episode in series.episodes
            }
            try:
                for future in as_completed(futures):
                    number = futures[future]
                    try:
                        path = future.result()
                        if path:
                            results[number] = path
                    except PipelineCancelled:
                        raise
                    except Exception as exc:
                        failures.append(f"第 {number} 集：{exc}")
                        self.emit("log", f"第 {number} 集识别失败：{exc}")
                    finally:
                        counter["done"] += 1
                        self._progress(
                            "transcribe",
                            counter["done"] / total if total else 0,
                            f"已处理 {counter['done']}/{total} 集。",
                            transcribed=len(results),
                            current_episode=number,
                        )
                    self.check_cancel()
            except PipelineCancelled:
                for future in futures:
                    future.cancel()
                raise

        if not results:
            raise RuntimeError("所有剧集都识别失败：" + "；".join(failures[:5]))
        if failures:
            self.emit(
                "log",
                f"有 {len(failures)} 集识别失败，已跳过：" + "；".join(failures[:5]),
            )
        return results

    def _merge(
        self,
        series: Series,
        workdir: Path,
        series_dir: Optional[Path],
        srt_paths: Dict[int, Path],
        ffmpeg_path: Optional[str],
    ) -> Dict[str, Any]:
        self._progress("merge", 0.1, "正在合并全剧字幕。")
        merged_dir = workdir / "series"
        prompt_dir = workdir / "prompt"
        merged_dir.mkdir(parents=True, exist_ok=True)
        prompt_dir.mkdir(parents=True, exist_ok=True)

        all_segments: List[Segment] = []
        transcript_parts: List[str] = []
        episode_meta: List[Dict[str, Any]] = []
        offset = 0

        for episode in series.episodes:
            self.wait_if_paused()
            srt_path = srt_paths.get(episode.number)
            if not srt_path:
                continue
            self.check_cancel()
            segments = dedupe_segments(parse_subtitle_file(srt_path))
            paragraphs = segments_to_paragraphs(segments)
            transcript_parts.append(f"Episode {episode.number}\n\n{paragraphs}")
            all_segments.extend(offset_segments(segments, offset))
            duration_ms = int(episode.duration or 0) * 1000
            if duration_ms <= 0 and series_dir and ffmpeg_path:
                video = self._find_video(series_dir, series, episode.number)
                if video:
                    duration_ms = probe_duration(ffmpeg_path, video)
            if duration_ms <= 0 and segments:
                duration_ms = segments[-1].end
            offset += max(duration_ms, segments[-1].end if segments else 0)
            episode_meta.append(
                {
                    "number": episode.number,
                    "duration_ms": duration_ms,
                    "srt": str(srt_path),
                    "paragraphs": len([p for p in paragraphs.split("\n\n") if p]),
                    "chars": len(paragraphs),
                }
            )

        if not transcript_parts:
            raise RuntimeError("没有可合并的字幕。")

        transcript = "\n\n".join(transcript_parts).strip() + "\n"
        srt_path = merged_dir / "全剧字幕.srt"
        srt_path.write_text(segments_to_srt(all_segments), encoding="utf-8")
        transcript_path = merged_dir / "全剧台词.txt"
        transcript_path.write_text(transcript, encoding="utf-8")
        episodes_json = merged_dir / "episodes.json"
        episodes_json.write_text(
            json.dumps(episode_meta, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        skill_text = SKILL_PATH.read_text(encoding="utf-8")
        (prompt_dir / "skill.md").write_text(skill_text, encoding="utf-8")
        (prompt_dir / "全剧字幕.md").write_text(transcript, encoding="utf-8")
        prompt_path = prompt_dir / "一键投喂.md"
        prompt_path.write_text(
            skill_text.strip()
            + "\n\n---\n\n# 原作全剧字幕稿\n\n"
            + transcript
            + "\n",
            encoding="utf-8",
        )

        self._progress("merge", 1.0, "全剧字幕已合并。")
        return {
            "transcript": transcript,
            "transcript_path": str(transcript_path),
            "srt_path": str(srt_path),
            "episodes_json": str(episodes_json),
            "prompt_path": str(prompt_path),
            "artifacts": [
                {"key": "transcript", "label": "全剧台词.txt", "path": str(transcript_path)},
                {"key": "series_srt", "label": "全剧字幕.srt", "path": str(srt_path)},
                {"key": "prompt", "label": "一键投喂.md", "path": str(prompt_path)},
            ],
        }

    def _script_emit(self, event_type: str, message: str, **extra: Any) -> None:
        if event_type == "script_progress":
            batches = int(extra.get("batches") or 1)
            batch = int(extra.get("batch") or 0)
            self._progress(
                "script",
                batch / batches if batches else 0,
                message,
                script_batch=batch,
                script_batches=batches,
                current_episode=extra.get("episode"),
            )
            return
        self.emit(event_type, message, **extra)

    @staticmethod
    def _llm_kwargs(config: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "base_url": str(config.get("base_url") or "https://api.deepseek.com/v1"),
            "api_key": str(config.get("api_key") or ""),
            "model": str(config.get("model") or "deepseek-chat"),
            "temperature": float(config.get("temperature") or 0.8),
            "max_tokens": int(config.get("max_tokens") or 8192),
            "timeout": int(config.get("timeout") or 900),
        }
