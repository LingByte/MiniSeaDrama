"""Staged script generation: plan -> episodes -> rating -> Word files."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .docx_writer import clean_script_text, write_script_docx, write_setting_docx
from .llm import LLMClient, LLMError
from .prompts import (
    build_character_messages,
    build_episode_messages,
    build_plan_messages,
)

Emit = Callable[..., None]
CODE_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*$")
EPISODE_HEADER_RE = re.compile(r"(?m)^\s*Episode\s+(\d+)\s*$", re.IGNORECASE)
MAX_TRANSCRIPT_CHARS = 200_000


def _escape_string_newlines(text: str) -> str:
    """把字符串内部未转义的换行替换成 \\n，避免整段 JSON 失真。"""
    out: List[str] = []
    in_string = False
    escaped = False
    for char in text:
        if in_string:
            if escaped:
                out.append(char)
                escaped = False
            elif char == "\\":
                out.append(char)
                escaped = True
            elif char == '"':
                out.append(char)
                in_string = False
            elif char == "\n":
                out.append("\\n")
            elif char == "\r":
                continue
            else:
                out.append(char)
        else:
            if char == '"':
                in_string = True
            out.append(char)
    return "".join(out)


def _repair_json(text: str) -> str:
    """修补模型常见的 JSON 写法问题：裸字符串数组项、尾随逗号。"""
    lines: List[str] = _escape_string_newlines(text).splitlines()
    fixed: List[str] = []
    stack: List[str] = []
    in_string = False
    escaped = False
    for line in lines:
        stripped = line.strip()
        if stripped and not in_string and stack and stack[-1] == "[":
            first = stripped[0]
            if first not in '"[{]}' and not re.match(r"[-0-9tfn]", first):
                body = stripped
                comma = body.endswith(",")
                if comma:
                    body = body[:-1]
                body = body.replace("\\", "\\\\").replace('"', '\\"')
                line = '"' + body + '"' + ("," if comma else "")

        fixed.append(line)
        for char in line:
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            elif char == '"':
                in_string = True
            elif char in "[{":
                stack.append(char)
            elif char in "]}":
                if stack:
                    stack.pop()
    repaired = "\n".join(fixed)
    return re.sub(r",(\s*[}\]])", r"\1", repaired)


def extract_json(text: str) -> Dict[str, Any]:
    cleaned = "\n".join(
        line for line in (text or "").splitlines() if not CODE_FENCE_RE.match(line.strip())
    ).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("模型没有返回 JSON 对象。")
    body = cleaned[start : end + 1]
    try:
        payload = json.loads(body, strict=False)
    except json.JSONDecodeError:
        payload = json.loads(_repair_json(body), strict=False)
    if not isinstance(payload, dict):
        raise ValueError("模型返回的 JSON 顶层不是对象。")
    return payload


def _slice_episode_text(text: str, first_number: int) -> str:
    cleaned = "\n".join(
        line for line in (text or "").splitlines() if not CODE_FENCE_RE.match(line.strip())
    ).strip()
    match = re.search(
        rf"(?m)^\s*Episode\s+{first_number}\s*$",
        cleaned,
        re.IGNORECASE,
    )
    if match:
        return cleaned[match.start() :].strip()
    header = re.search(r"(?m)^\s*Episode\s+\d+\s*$", cleaned, re.IGNORECASE)
    return cleaned[header.start() :].strip() if header else cleaned


class ScriptGenerator:
    def __init__(
        self,
        client: LLMClient,
        skill: str,
        emit: Emit,
        batch_size: int = 3,
        wait: Optional[Callable[[], None]] = None,
    ) -> None:
        self.client = client
        self.skill = skill
        self.emit = emit
        self.batch_size = max(1, min(10, batch_size))
        self.wait = wait or (lambda: None)

    def _chat_json(
        self,
        messages: List[Dict[str, str]],
        label: str,
    ) -> Dict[str, Any]:
        last_error: Optional[Exception] = None
        for attempt in range(1, 3):
            text = self.client.chat(messages, json_mode=True)
            try:
                return extract_json(text)
            except (ValueError, json.JSONDecodeError) as exc:
                last_error = exc
                self.emit(
                    "log",
                    f"{label} 返回内容不是合法 JSON，正在重试（{attempt}/2）。",
                )
                messages = messages + [
                    {
                        "role": "user",
                        "content": "上一次输出不是合法 JSON。请只输出 JSON 对象，"
                        "不要 Markdown 代码块，不要任何解释。",
                    }
                ]
        raise LLMError(f"{label} 没有产出合法 JSON：{last_error}")

    def generate(self, workdir: Path, transcript: str) -> Dict[str, Any]:
        output_dir = workdir / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        episodes_dir = output_dir / "episodes"
        episodes_dir.mkdir(parents=True, exist_ok=True)

        compact = transcript[:MAX_TRANSCRIPT_CHARS]

        self.wait()
        self.emit("log", "正在生成全剧策划与分集大纲。")
        plan = self._chat_json(
            build_plan_messages(self.skill, compact),
            "策划阶段",
        )
        self.wait()
        self.emit("log", "正在生成人物台词设定卡。")
        character_payload = self._chat_json(
            build_character_messages(self.skill, plan),
            "人物卡阶段",
        )
        plan["characters"] = character_payload.get("characters") or []
        plan_path = output_dir / "plan.json"
        plan_path.write_text(
            json.dumps(plan, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        episodes: List[Dict[str, Any]] = [
            item for item in plan.get("episodes") or [] if isinstance(item, dict)
        ]
        episodes.sort(key=lambda item: int(item.get("number") or 0))
        if not episodes:
            raise LLMError("策划阶段没有产出分集大纲。")
        self.emit(
            "log",
            f"策划完成：{plan.get('title_en', '')}，共 {len(episodes)} 集。",
            title_cn=plan.get("title_cn"),
            title_en=plan.get("title_en"),
            episode_count=len(episodes),
        )

        scripts: List[str] = []
        total_batches = (len(episodes) + self.batch_size - 1) // self.batch_size
        for batch_index in range(total_batches):
            self.wait()
            batch = episodes[
                batch_index * self.batch_size : (batch_index + 1) * self.batch_size
            ]
            first_number = int(batch[0].get("number") or 0)
            batch_name = (
                f"E{int(batch[0].get('number') or 0):03d}-"
                f"E{int(batch[-1].get('number') or 0):03d}.md"
            )
            batch_path = episodes_dir / batch_name
            if batch_path.is_file() and batch_path.stat().st_size > 0:
                scripts.append(batch_path.read_text(encoding="utf-8"))
                self.emit(
                    "script_progress",
                    f"第 {batch[0].get('number')}~{batch[-1].get('number')} 集已存在，直接复用。",
                    batch=batch_index + 1,
                    batches=total_batches,
                    episode=int(batch[-1].get("number") or 0),
                )
                continue
            previous_tail = "\n".join(scripts)[-1500:] if scripts else ""
            self.emit(
                "script_progress",
                f"正在写第 {batch[0].get('number')}~{batch[-1].get('number')} 集"
                f"（{batch_index + 1}/{total_batches}）。",
                batch=batch_index + 1,
                batches=total_batches,
                episode=first_number,
            )
            text = self.client.chat(
                build_episode_messages(
                    self.skill,
                    plan,
                    batch,
                    previous_tail,
                )
            )
            text = _slice_episode_text(text, first_number)
            scripts.append(text)
            batch_path.write_text(text, encoding="utf-8")
            self.emit(
                "script_progress",
                f"第 {batch[0].get('number')}~{batch[-1].get('number')} 集完成。",
                batch=batch_index + 1,
                batches=total_batches,
                episode=int(batch[-1].get("number") or 0),
            )

        full_script = "\n\n".join(clean_script_text(item) for item in scripts)
        script_md = output_dir / "剧本.md"
        script_md.write_text(full_script, encoding="utf-8")

        rating = self._rating()
        (output_dir / "rating.json").write_text(
            json.dumps(rating, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        title_en = str(plan.get("title_en") or "Untitled")
        meta = _build_meta(plan, rating, full_script)
        meta_path = output_dir / "设定要点.json"
        meta_path.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        script_docx = write_script_docx(
            output_dir / "剧本.docx",
            title_en,
            scripts,
        )
        setting_docx = write_setting_docx(
            output_dir / "设定.docx",
            plan,
            rating,
        )
        self.emit("log", "剧本与设定 Word 已生成。")
        return {
            "title_cn": plan.get("title_cn"),
            "title_en": title_en,
            "episode_count": len(episodes),
            "plan_json": str(plan_path),
            "script_md": str(script_md),
            "script_docx": str(script_docx),
            "setting_docx": str(setting_docx),
            "rating": rating,
            "meta": meta,
            "meta_json": str(meta_path),
        }

    def _rating(self) -> Dict[str, Any]:
        """跳过耗时的模型评级，直接给默认等级；标签分类来自策划阶段的 plan.categories。"""
        self.emit("log", "已跳过模型评级，直接使用默认等级 B。")
        return {
            "grade": "B",
            "score": 80,
            "items": [],
            "caps": "未触发",
            "gap": [],
        }


EPISODE_HEADER_RE = re.compile(r"(?m)^\s*Episode\s+(\d+)\s*$", re.IGNORECASE)


def _split_episodes(text: str) -> List[Dict[str, Any]]:
    """把整篇剧本按「Episode N」切成试读可用的分集内容。"""
    source = text or ""
    matches = list(EPISODE_HEADER_RE.finditer(source))
    if not matches:
        body = source.strip()
        return [{"title": "第 1 集", "text": body}] if body else []
    episodes: List[Dict[str, Any]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(source)
        number = int(match.group(1))
        episodes.append(
            {
                "title": f"第 {number} 集",
                "text": source[start:end].strip(),
            }
        )
    return episodes


def _build_meta(
    plan: Dict[str, Any],
    rating: Dict[str, Any],
    full_script: str,
) -> Dict[str, Any]:
    """生成管理端上架所需的结构化要点，前端可直接回填表单。"""
    categories = plan.get("categories") or {}
    subs = [str(item) for item in categories.get("subs") or []]
    main = str(categories.get("main") or "")
    cover = plan.get("cover") or {}
    prompt_parts = [
        str(cover.get(key) or "").strip()
        for key in ("visual", "palette", "composition", "tagline")
    ]
    prompt = "，".join(part for part in prompt_parts if part)
    if prompt:
        prompt += "，竖版 3:4 短剧海报，电影感光影，主体居中，高清细节，画面不要文字"
    episode_list = _split_episodes(full_script)
    audience_text = main + "".join(subs)
    return {
        "title": str(plan.get("title_cn") or ""),
        "enTitle": str(plan.get("title_en") or ""),
        "logline": str(plan.get("logline") or "")[:40],
        "synopsis": "".join(str(p) for p in plan.get("plot_summary") or [])[:300],
        "totalEpisodes": len(episode_list),
        "language": "英语",
        "audience": "男频" if "男频" in audience_text else "女频",
        "quality": str(rating.get("grade") or ""),
        "categories": {"main": main, "subs": subs},
        "coverPrompt": prompt,
        "episodes": episode_list,
    }
