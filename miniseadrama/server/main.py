"""FastAPI application exposing the MiniSeaDrama workflow."""

from __future__ import annotations

import asyncio
import json
import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .core import asr
from .core.cookies import parse_cookie_header
from .core.pipeline import STAGE_LABELS
from .core.settings import (
    SKILL_PATH,
    WEB_DIST,
    WORK_DIR,
    ensure_dirs,
    find_ffmpeg,
    save_settings,
    load_settings,
)
from .core.shortflix import discover_series
from .jobs import MANAGER, TERMINAL_STATUSES

ensure_dirs()

app = FastAPI(title="MiniSeaDrama", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _defaults_payload() -> Dict[str, Any]:
    try:
        ffmpeg_path: Optional[str] = find_ffmpeg()
    except RuntimeError:
        ffmpeg_path = None
    settings = load_settings()
    return {
        "version": __version__,
        "ffmpeg_path": ffmpeg_path,
        "saved_ffmpeg_path": settings.get("ffmpeg_path"),
        "output_root": str(WORK_DIR),
        "engines": asr.engine_options(),
        "default_engine": asr.DEFAULT_ENGINE,
        "skill_present": SKILL_PATH.is_file(),
        "stages": STAGE_LABELS,
    }


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return _defaults_payload()


@app.post("/api/settings")
def update_settings(payload: Dict[str, Any]) -> Dict[str, Any]:
    values: Dict[str, Any] = {}
    if payload.get("ffmpeg_path"):
        values["ffmpeg_path"] = str(payload["ffmpeg_path"]).strip()
    save_settings(values)
    return _defaults_payload()


@app.post("/api/inspect")
def inspect(payload: Dict[str, Any]) -> Dict[str, Any]:
    url = str(payload.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="请填写 ShortFlix 剧目链接。")
    cookie = parse_cookie_header(str(payload.get("cookie") or ""))
    try:
        series = discover_series(url, cookie_header=cookie or None)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "title": series.title,
        "slug": series.slug,
        "source_url": series.source_url,
        "episode_count": len(series.episodes),
        "episodes": [
            {
                "number": episode.number,
                "title": episode.title,
                "duration": episode.duration,
                "qualities": [version.quality for version in episode.versions],
            }
            for episode in series.episodes
        ],
    }


def _validate_job_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    url = str(payload.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="请填写 ShortFlix 剧目链接。")
    engine = str(payload.get("engine") or asr.DEFAULT_ENGINE).lower()
    if engine not in asr.ENGINES:
        raise HTTPException(status_code=400, detail=f"不支持的 ASR 接口：{engine}")

    def _int(name: str, default: int, low: int, high: int) -> int:
        try:
            value = int(payload.get(name) or default)
        except (TypeError, ValueError):
            value = default
        return max(low, min(high, value))

    llm = payload.get("llm") or {}
    if not isinstance(llm, dict):
        llm = {}
    return {
        "url": url,
        "cookie": str(payload.get("cookie") or ""),
        "engine": engine,
        "workers": _int("workers", 3, 1, 6),
        "batch_size": _int("batch_size", 3, 1, 6),
        "force_asr": bool(payload.get("force_asr")),
        "redo_asr": bool(payload.get("redo_asr")),
        "ffmpeg": str(payload.get("ffmpeg") or "").strip() or None,
        "output_root": str(payload.get("output_root") or WORK_DIR),
        "llm": {
            "base_url": str(llm.get("base_url") or "https://team.lingecho.com/v1"),
            "api_key": str(llm.get("api_key") or "").strip(),
            "model": str(llm.get("model") or "claude-opus-5.5特价"),
            "temperature": float(llm.get("temperature") or 0.8),
            "max_tokens": int(llm.get("max_tokens") or 8192),
            "timeout": int(llm.get("timeout") or 900),
        },
    }


@app.post("/api/jobs")
def create_job(payload: Dict[str, Any]) -> Dict[str, Any]:
    params = _validate_job_payload(payload)
    try:
        find_ffmpeg(params.get("ffmpeg"))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    job = MANAGER.create(params)
    return job.to_dict()


@app.get("/api/jobs")
def list_jobs() -> Dict[str, Any]:
    return {"items": MANAGER.list()}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> Dict[str, Any]:
    job = MANAGER.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在。")
    return job.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> Dict[str, Any]:
    if not MANAGER.cancel(job_id):
        raise HTTPException(status_code=404, detail="任务不存在。")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/pause")
def pause_job(job_id: str) -> Dict[str, Any]:
    if not MANAGER.pause(job_id):
        raise HTTPException(status_code=404, detail="任务不存在或已结束。")
    return {"ok": True, "paused": True}


@app.post("/api/jobs/{job_id}/resume")
def resume_job(job_id: str) -> Dict[str, Any]:
    if not MANAGER.resume(job_id):
        raise HTTPException(status_code=404, detail="任务不存在。")
    return {"ok": True, "paused": False}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request, after: int = 0):
    job = MANAGER.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在。")

    async def stream():
        last = max(0, after)
        while True:
            if await request.is_disconnected():
                break
            events = MANAGER.events_since(job, last)
            for event in events:
                last = int(event["seq"])
                payload = json.dumps(event, ensure_ascii=False)
                yield f"id: {last}\ndata: {payload}\n\n"
            if job.status in TERMINAL_STATUSES and not events:
                break
            yield ": ping\n\n"
            await asyncio.sleep(0.6)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


@app.get("/api/jobs/{job_id}/files/{key}")
def download_artifact(job_id: str, key: str):
    job = MANAGER.get(job_id)
    if not job or not job.result:
        raise HTTPException(status_code=404, detail="任务结果不存在。")
    workdir = Path(str(job.result.get("workdir") or "")).resolve()
    artifacts: List[Dict[str, Any]] = job.result.get("artifacts") or []
    artifact = next((item for item in artifacts if item.get("key") == key), None)
    if not artifact:
        raise HTTPException(status_code=404, detail="文件不存在。")
    path = Path(str(artifact.get("path") or "")).resolve()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件已被移动或删除。")
    try:
        path.relative_to(workdir)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="不允许下载工作目录之外的文件。") from exc
    media_type = DOCX_MEDIA_TYPE if path.suffix.lower() == ".docx" else "text/plain; charset=utf-8"
    return FileResponse(path, media_type=media_type, filename=path.name)


ARTIFACT_FILES: Dict[str, str] = {
    "script_docx": "剧本.docx",
    "setting_docx": "设定.docx",
    "meta_json": "设定要点.json",
    "script_md": "剧本.md",
    "plan_json": "plan.json",
}


def _output_dir_for_url(url: str) -> Optional[Path]:
    """按 ShortFlix 链接里的 slug 找到该剧最近一次生成的工作目录。"""
    match = re.search(r"/videos/([^/?#]+)", url or "")
    slug = match.group(1) if match else ""
    if not slug:
        return None
    root = Path(str(WORK_DIR))
    if not root.is_dir():
        return None
    candidates = [
        folder / "output"
        for folder in root.iterdir()
        if folder.is_dir()
        and f"[{slug}]" in folder.name
        and (folder / "output").is_dir()
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda item: item.stat().st_mtime)


@app.get("/api/artifacts")
def list_artifacts(url: str = "") -> Dict[str, Any]:
    """列出该剧工作目录里已存在的产物（任务未完成时也能读）。"""
    output_dir = _output_dir_for_url(url)
    if output_dir is None:
        raise HTTPException(status_code=404, detail="还没有生成过该剧的产物。")
    artifacts: List[Dict[str, Any]] = []
    for key, name in ARTIFACT_FILES.items():
        path = output_dir / name
        if path.is_file():
            stat = path.stat()
            artifacts.append(
                {
                    "key": key,
                    "label": name,
                    "size": stat.st_size,
                    "updated_at": stat.st_mtime,
                }
            )
    if not artifacts:
        raise HTTPException(status_code=404, detail="该剧工作目录里没有可用产物。")
    return {"workdir": str(output_dir.parent), "artifacts": artifacts}


@app.get("/api/artifacts/file")
def download_existing_artifact(url: str = "", key: str = ""):
    name = ARTIFACT_FILES.get(key)
    if not name:
        raise HTTPException(status_code=400, detail="不支持的产物类型。")
    output_dir = _output_dir_for_url(url)
    if output_dir is None:
        raise HTTPException(status_code=404, detail="还没有生成过该剧的产物。")
    path = output_dir / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在。")
    media_type = (
        DOCX_MEDIA_TYPE if path.suffix.lower() == ".docx" else "text/plain; charset=utf-8"
    )
    return FileResponse(path, media_type=media_type, filename=path.name)


if WEB_DIST.is_dir():
    assets_dir = WEB_DIST / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        return HTMLResponse((WEB_DIST / "index.html").read_text(encoding="utf-8"))

    @app.get("/{path:path}")
    def spa_fallback(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="接口不存在。")
        candidate = (WEB_DIST / path).resolve()
        if candidate.is_file():
            return FileResponse(candidate)
        return HTMLResponse((WEB_DIST / "index.html").read_text(encoding="utf-8"))
else:

    @app.get("/", response_class=HTMLResponse)
    def index_missing() -> HTMLResponse:
        return HTMLResponse(
            "<h1>MiniSeaDrama</h1>"
            "<p>前端尚未构建。请在 web 目录执行 <code>npm install</code> 和 "
            "<code>npm run build</code>，或使用 <code>npm run dev</code> 开发模式。</p>"
        )
