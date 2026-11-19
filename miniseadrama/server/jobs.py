"""In-memory job queue with SSE-friendly event logs."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .core.pipeline import Pipeline, PipelineCancelled

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


@dataclass
class Job:
    id: str
    params: Dict[str, Any] = field(default_factory=dict)
    display_params: Dict[str, Any] = field(default_factory=dict)
    status: str = "queued"
    message: str = "排队中"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    progress: Dict[str, Any] = field(default_factory=dict)
    events: List[Dict[str, Any]] = field(default_factory=list)
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    pause_event: threading.Event = field(default_factory=threading.Event)
    pipeline: Optional[Pipeline] = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    seq: int = 0

    def add_event(self, event_type: str, message: str, **extra: Any) -> None:
        with self.lock:
            self.seq += 1
            event = {
                "seq": self.seq,
                "at": time.time(),
                "type": event_type,
                "message": message,
            }
            for key, value in extra.items():
                if key == "progress" and isinstance(value, dict):
                    self.progress = value
                    event["progress"] = value
                elif key == "series" and isinstance(value, dict):
                    self.display_params["series_title"] = value.get("title")
                    event["series"] = value
                elif key in {"artifacts", "result"}:
                    event[key] = value
                elif isinstance(value, (str, int, float, bool)) or value is None:
                    event[key] = value
            self.events.append(event)
            if len(self.events) > 3000:
                self.events = self.events[-3000:]
            self.message = message or self.message
            self.updated_at = event["at"]

    def to_dict(self, include_events: bool = False) -> Dict[str, Any]:
        with self.lock:
            payload = {
                "id": self.id,
                "status": self.status,
                "paused": self.pause_event.is_set(),
                "message": self.message,
                "created_at": self.created_at,
                "updated_at": self.updated_at,
                "params": self.display_params,
                "progress": self.progress,
                "result": self.result,
                "error": self.error,
                "event_seq": self.seq,
            }
            if include_events:
                payload["events"] = list(self.events)
            return payload


class JobManager:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._order: List[str] = []
        self._lock = threading.RLock()
        self._queue: List[str] = []
        self._worker: Optional[threading.Thread] = None
        self._worker_active = False

    def create(self, params: Dict[str, Any]) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:12],
            params=params,
            display_params=self._display_params(params),
        )
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._queue.append(job.id)
            self._ensure_worker_locked()
        job.add_event("queued", "任务已加入队列。")
        return job

    @staticmethod
    def _display_params(params: Dict[str, Any]) -> Dict[str, Any]:
        display = {key: value for key, value in params.items() if key != "cookie"}
        llm = dict(display.get("llm") or {})
        if llm.get("api_key"):
            llm["api_key"] = "***"
            llm["configured"] = True
        else:
            llm["configured"] = False
        display["llm"] = llm
        display["has_cookie"] = bool(params.get("cookie"))
        return display

    def _ensure_worker_locked(self) -> None:
        if self._worker_active:
            return
        self._worker_active = True
        self._worker = threading.Thread(
            target=self._worker_loop,
            name="minisea-job-worker",
            daemon=True,
        )
        self._worker.start()

    def _worker_loop(self) -> None:
        while True:
            with self._lock:
                job: Optional[Job] = None
                while self._queue:
                    candidate = self._jobs.get(self._queue.pop(0))
                    if candidate and candidate.status == "queued":
                        job = candidate
                        break
                if job is None:
                    self._worker_active = False
                    self._worker = None
                    return
                job.status = "running"
                job.add_event("status", "任务开始。")
            self._run(job)

    def _run(self, job: Job) -> None:
        pipeline = Pipeline(job.params, job.add_event, job.cancel_event, job.pause_event)
        with job.lock:
            job.pipeline = pipeline
        try:
            result = pipeline.run()
            with job.lock:
                job.status = "completed"
                job.result = result
            job.add_event(
                "done",
                "全流程完成。",
                result=result,
                artifacts=result.get("artifacts", []),
            )
        except PipelineCancelled:
            with job.lock:
                job.status = "cancelled"
            job.add_event("cancelled", "任务已取消。")
        except Exception as exc:  # 后台任务必须把错误回传给前端
            message = str(exc) or exc.__class__.__name__
            with job.lock:
                job.status = "failed"
                job.error = message
            job.add_event("error", f"任务失败：{message}")
        finally:
            with job.lock:
                job.pipeline = None

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [
                self._jobs[job_id].to_dict()
                for job_id in reversed(self._order)
                if job_id in self._jobs
            ]

    def events_since(self, job: Job, seq: int) -> List[Dict[str, Any]]:
        with job.lock:
            return [event for event in job.events if event["seq"] > seq]

    def pause(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job or job.status != "running":
            return False
        if job.pause_event.is_set():
            return True
        job.pause_event.set()
        job.add_event("paused", "已暂停：当前步骤结束后停下。")
        return True

    def resume(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job:
            return False
        if not job.pause_event.is_set():
            return True
        job.pause_event.clear()
        job.add_event("resumed", "已继续。")
        return True

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job:
            return False
        job.pause_event.clear()
        job.cancel_event.set()
        with job.lock:
            if job.status == "queued":
                job.status = "cancelled"
                job.add_event("cancelled", "已从队列中取消。")
                return True
            pipeline = job.pipeline
        if pipeline and pipeline.downloader:
            pipeline.downloader.cancel()
        return True


MANAGER = JobManager()
