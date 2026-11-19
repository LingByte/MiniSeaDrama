"""Word export for 剧本.docx and 设定.docx."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt

EPISODE_LINE_RE = re.compile(r"^Episode\s+\d+\s*$", re.IGNORECASE)
SCENE_HEADER_RE = re.compile(
    r"^\d+\s*-\s*\d+\s+.+\[(?:INT|EXT)\.?\]\s*\[(?:DAY|NIGHT)\]",
    re.IGNORECASE,
)
END_EPISODE_RE = re.compile(r"END OF EPISODE\s+\d+", re.IGNORECASE)
END_SERIES_RE = re.compile(r"END OF SERIES", re.IGNORECASE)
CODE_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*$")
WATERMARK_RE = re.compile(
    r"("
    r"由\s*(?:AI|人工智能|大模型|ChatGPT|Claude|GPT)[^。\n]{0,20}(?:生成|创作|撰写|辅助)"
    r"|(?:AI|人工智能|大模型|ChatGPT|Claude|GPT|机器)\s*(?:生成|创作|撰写|写作)"
    r"|(?:generated|created|written)\s+(?:by|with)\s+(?:AI|ChatGPT|Claude|GPT)"
    r"|AI[- ]generated"
    r"|本(?:剧本|文档|作品|内容)[^。\n]{0,20}(?:AI|人工智能)[^。\n]{0,20}"
    r")",
    re.IGNORECASE,
)


def clean_script_text(text: str) -> str:
    """去掉围栏、AI 声明/水印行与多余空白，保证成稿干净。"""
    lines = []
    for line in (text or "").replace("\r\n", "\n").split("\n"):
        stripped = line.strip()
        if CODE_FENCE_RE.match(stripped):
            continue
        if stripped and WATERMARK_RE.search(stripped):
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip()


def _base_document() -> Document:
    document = Document()
    props = document.core_properties
    props.author = ""
    props.last_modified_by = ""
    props.comments = ""
    props.subject = ""
    props.category = ""
    props.keywords = ""
    props.title = ""
    normal = document.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(11)
    rpr = normal.element.get_or_add_rPr()
    rpr.rFonts.set(qn("w:eastAsia"), "微软雅黑")
    section = document.sections[0]
    section.left_margin = section.right_margin = Pt(72)
    return document


def _add_text(
    document: Document,
    text: str,
    size: float = 11,
    bold: bool = False,
    center: bool = False,
    space_before: float = 0,
    space_after: float = 0,
):
    paragraph = document.add_paragraph()
    if center:
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.space_before = Pt(space_before)
    paragraph.paragraph_format.space_after = Pt(space_after)
    run = paragraph.add_run(text)
    run.bold = bold
    run.font.size = Pt(size)
    return paragraph


def _clean_episode_text(text: str) -> str:
    return clean_script_text(text)


def write_script_docx(
    path: Path,
    title_en: str,
    episodes: Sequence[str],
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    document = _base_document()
    _add_text(document, title_en, size=18, bold=False, center=True, space_after=18)

    last_episode_number = 0
    for raw in episodes:
        text = _clean_episode_text(raw)
        if not text:
            continue
        for line in text.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            if EPISODE_LINE_RE.match(stripped):
                match = re.search(r"\d+", stripped)
                if match:
                    last_episode_number = int(match.group(0))
                _add_text(document, stripped, size=13, space_before=18, space_after=8)
                continue
            if END_EPISODE_RE.search(stripped):
                _add_text(document, "— END OF EPISODE %d —" % last_episode_number,
                          bold=True, center=True, space_before=12, space_after=6)
                continue
            if END_SERIES_RE.search(stripped):
                _add_text(document, "END OF SERIES", bold=True, center=True,
                          space_before=12)
                continue
            if SCENE_HEADER_RE.match(stripped):
                _add_text(document, stripped, space_before=10, space_after=4)
                continue
            if stripped.startswith("△") or stripped.startswith("[SFX]"):
                _add_text(document, stripped, space_after=4)
                continue
            _add_text(document, stripped, space_after=4)

    if not any(END_SERIES_RE.search(item or "") for item in episodes):
        _add_text(document, "END OF SERIES", bold=True, center=True, space_before=12)
    document.save(str(path))
    return path


def _section_title(document: Document, text: str) -> None:
    _add_text(document, text, size=14, bold=True, space_before=16, space_after=6)


def _paragraphs(document: Document, values: Iterable[str]) -> None:
    for value in values:
        text = str(value or "").strip()
        if text:
            _add_text(document, text, space_after=4)


def write_setting_docx(
    path: Path,
    plan: Dict[str, Any],
    rating: Dict[str, Any],
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    document = _base_document()

    title_cn = str(plan.get("title_cn") or "").strip()
    title_en = str(plan.get("title_en") or "").strip()
    _add_text(
        document,
        f"《{title_cn}》" if title_cn else title_en,
        size=20,
        bold=True,
        center=True,
        space_after=4,
    )
    _add_text(document, title_en, size=15, center=True, space_after=12)

    categories = plan.get("categories") or {}
    _section_title(document, "一、情节类别")
    _paragraphs(
        document,
        [
            f"主类别：{categories.get('main', '')}",
            "副标签：" + "、".join(str(item) for item in categories.get("subs", [])),
            f"货架定位：{categories.get('shelf', '')}",
        ],
    )

    _section_title(document, "二、品质评级")
    if rating:
        _add_text(
            document,
            f"品质评级：{rating.get('grade', '')}（{rating.get('score', '')} / 100）",
            bold=True,
            space_after=4,
        )
        items = rating.get("items") or []
        if items:
            table = document.add_table(rows=1, cols=4)
            table.style = "Table Grid"
            header = table.rows[0].cells
            for index, label in enumerate(("项目", "得分", "满分", "依据")):
                header[index].text = label
            for item in items:
                cells = table.add_row().cells
                cells[0].text = str(item.get("name", ""))
                cells[1].text = str(item.get("score", ""))
                cells[2].text = str(item.get("max", ""))
                cells[3].text = str(item.get("reason", ""))
        _paragraphs(
            document,
            [
                f"封顶：{rating.get('caps', '未触发')}",
                "到下一档差什么：",
                *[f"· {item}" for item in rating.get("gap", [])],
            ],
        )
    else:
        _paragraphs(document, ["本次未生成评级。"])

    cover = plan.get("cover") or {}
    _section_title(document, "三、封面设计")
    _paragraphs(
        document,
        [
            f"画面：{cover.get('visual', '')}",
            f"色调：{cover.get('palette', '')}",
            f"构图：{cover.get('composition', '')}",
            f"标题：{cover.get('title', '')}",
            f"标语：{cover.get('tagline', '')}",
        ],
    )

    _section_title(document, "四、剧情梗概")
    _paragraphs(document, plan.get("plot_summary") or [])

    _section_title(document, "五、人物设定")
    for character in plan.get("characters") or []:
        name = str(character.get("name") or "").strip()
        role = str(character.get("role") or "").strip()
        _add_text(document, f"{name}（{role}）", bold=True, space_before=8, space_after=3)
        card: List[str] = [str(item) for item in character.get("card") or []]
        if card:
            _paragraphs(document, card)
        else:
            _paragraphs(
                document,
                [
                    f"一根筋：{character.get('one_track', '')}",
                    f"反差：{character.get('contrast', '')}",
                    f"招牌：{character.get('signature', '')}",
                    f"外形锁定：{character.get('look', '')}",
                ],
            )

    document.save(str(path))
    return path
