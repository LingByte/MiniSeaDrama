"""ASR engine registry ported from AsrTools."""

from __future__ import annotations

import time
from typing import Callable, Dict, Optional, Tuple, Type

from .base import BaseASR
from .bcut import BcutASR
from .jianying import JianYingASR
from .kuaishou import KuaiShouASR
from .models import ASRData, ASRDataSeg

ENGINES: Dict[str, Tuple[str, Type[BaseASR]]] = {
    "bcut": ("必剪 B 接口", BcutASR),
    "jianying": ("剪映 J 接口", JianYingASR),
    "kuaishou": ("快手 K 接口", KuaiShouASR),
}

DEFAULT_ENGINE = "bcut"


def engine_options() -> list[dict[str, str]]:
    return [
        {"value": key, "label": label}
        for key, (label, _cls) in ENGINES.items()
    ]


def transcribe(
    audio_path: str,
    engine: str = DEFAULT_ENGINE,
    use_cache: bool = True,
    retries: int = 2,
    progress: Optional[Callable[[str], None]] = None,
) -> ASRData:
    """Run one ASR engine with retries and return timestamped segments."""
    key = (engine or DEFAULT_ENGINE).lower()
    if key not in ENGINES:
        raise ValueError(f"未知的 ASR 接口：{engine}")
    label, engine_cls = ENGINES[key]
    last_error: Optional[Exception] = None
    attempts = max(1, retries + 1)
    for attempt in range(1, attempts + 1):
        try:
            if progress:
                progress(f"{label} 第 {attempt}/{attempts} 次识别")
            asr = engine_cls(audio_path, use_cache=use_cache)
            return asr.run()
        except Exception as exc:  # 网络接口失败需要重试
            last_error = exc
            if attempt < attempts:
                if progress:
                    progress(f"{label} 失败，{attempt * 2} 秒后重试：{exc}")
                time.sleep(attempt * 2)
    raise RuntimeError(f"{label} 识别失败：{last_error}")


__all__ = [
    "ASRData",
    "ASRDataSeg",
    "BaseASR",
    "BcutASR",
    "JianYingASR",
    "KuaiShouASR",
    "ENGINES",
    "DEFAULT_ENGINE",
    "engine_options",
    "transcribe",
]
