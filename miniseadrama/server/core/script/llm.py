"""Minimal OpenAI-compatible chat client used by the script stage."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests


class LLMError(RuntimeError):
    """Raised when the model endpoint cannot be used."""


@dataclass
class LLMConfig:
    base_url: str = "https://api.deepseek.com/v1"
    api_key: str = ""
    model: str = "deepseek-chat"
    temperature: float = 0.8
    max_tokens: int = 8192
    timeout: int = 900

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.model and self.base_url)

    def public(self) -> Dict[str, Any]:
        return {
            "base_url": self.base_url,
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "configured": self.configured,
        }


class LLMClient:
    def __init__(self, config: LLMConfig):
        if not config.configured:
            raise LLMError("请先填写模型接口地址、API Key 和模型名称。")
        self.config = config
        base = config.base_url.strip().rstrip("/")
        self.endpoint = (
            base if base.endswith("/chat/completions") else base + "/chat/completions"
        )

    def chat(
        self,
        messages: List[Dict[str, str]],
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        json_mode: bool = False,
    ) -> str:
        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": (
                self.config.temperature if temperature is None else temperature
            ),
            "max_tokens": max_tokens or self.config.max_tokens,
            "stream": True,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.config.api_key}",
        }
        last_error: Optional[Exception] = None
        for attempt in range(1, 4):
            try:
                response = requests.post(
                    self.endpoint,
                    json=payload,
                    headers=headers,
                    timeout=(15, self.config.timeout),
                    stream=True,
                )
            except requests.RequestException as exc:
                last_error = exc
                time.sleep(attempt * 4)
                continue
            with response:
                response.encoding = "utf-8"
                if response.status_code in {429, 500, 502, 503, 504}:
                    last_error = LLMError(
                        f"模型接口返回 HTTP {response.status_code}："
                        f"{response.text[:300]}"
                    )
                    time.sleep(attempt * 5)
                    continue
                if response.status_code >= 400:
                    raise LLMError(
                        f"模型接口返回 HTTP {response.status_code}："
                        f"{response.text[:500]}"
                    )
                content_type = response.headers.get("Content-Type", "")
                if "event-stream" in content_type:
                    text = self._read_stream(response)
                else:
                    text = self._read_plain(response)
            if text:
                return text
            last_error = LLMError("模型返回了空内容。")
            time.sleep(attempt * 3)
        raise LLMError(f"模型请求失败：{last_error}")

    @staticmethod
    def _read_stream(response: requests.Response) -> str:
        pieces: List[str] = []
        for line in response.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if chunk == "[DONE]":
                break
            try:
                payload = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            choices = payload.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            piece = delta.get("content")
            if isinstance(piece, str):
                pieces.append(piece)
            elif isinstance(piece, list):
                pieces.extend(
                    str(item.get("text") or "")
                    for item in piece
                    if isinstance(item, dict)
                )
        return "".join(pieces).strip()

    @staticmethod
    def _read_plain(response: requests.Response) -> str:
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise LLMError("模型接口返回的不是 JSON。") from exc
        choices = data.get("choices") or []
        if not choices:
            raise LLMError(f"模型接口没有返回内容：{str(data)[:300]}")
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, list):
            content = "".join(
                str(item.get("text") or "")
                for item in content
                if isinstance(item, dict)
            )
        if not content:
            raise LLMError("模型返回了空内容。")
        return str(content)
