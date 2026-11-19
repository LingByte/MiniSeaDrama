"""Subtitle parsing, cleaning and merging for the drama pipeline."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

TAG_RE = re.compile(r"<[^>]+>")
ASS_TAG_RE = re.compile(r"\{[^}]*\}")
SPACE_RE = re.compile(r"\s+")
SENTENCE_END_RE = re.compile(r"[.!?。！？…]['\"”’)]?$")
NOISE_RE = re.compile(
    r"^(?:\[[^\]]{1,30}\]|\([^)]{1,30}\)|♪+|♫+|music|applause|laughter)$",
    re.IGNORECASE,
)
FULLWIDTH_PUNCT = str.maketrans(
    {
        "，": ",",
        "。": ".",
        "！": "!",
        "？": "?",
        "；": ";",
        "：": ":",
        "（": "(",
        "）": ")",
    }
)

ENGLISH_TITLE_RE = re.compile(
    r"(english|\beng\b|\ben[-_ ]?(?:us|gb)\b|英文|英语)",
    re.IGNORECASE,
)
OTHER_LANGUAGE_RE = re.compile(
    r"(spanish|español|portugu|français|french|german|deutsch|italian|"
    r"japanese|日本|korean|한국|chinese|mandarin|中文|arabic|русск|russian|"
    r"vietnamese|indonesian|thai|turkish|hindi|polish|dutch|filipino|malay)",
    re.IGNORECASE,
)
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
WORD_RE = re.compile(r"[A-Za-z]{2,}")
ENGLISH_STOPWORDS = {
    "the", "you", "and", "to", "is", "what", "that", "for", "me", "it",
    "we", "not", "this", "are", "your", "with", "have", "was", "be",
}
SRT_TIME_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{1,2})[.,](\d{1,3})"
)
VTT_TIME_RE = re.compile(
    r"(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*"
    r"(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})"
)


@dataclass
class Segment:
    start: int
    end: int
    text: str

    def shifted(self, offset_ms: int) -> "Segment":
        return Segment(
            start=self.start + offset_ms,
            end=self.end + offset_ms,
            text=self.text,
        )


def _to_ms(hours: str, minutes: str, seconds: str, fraction: str) -> int:
    ms = int((fraction + "000")[:3])
    return (
        int(hours or 0) * 3_600_000
        + int(minutes) * 60_000
        + int(seconds) * 1000
        + ms
    )


def parse_srt(text: str) -> List[Segment]:
    segments: List[Segment] = []
    for block in re.split(r"\r?\n\s*\r?\n", (text or "").strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        time_index = next(
            (index for index, line in enumerate(lines) if "-->" in line),
            -1,
        )
        if time_index < 0:
            continue
        match = SRT_TIME_RE.search(lines[time_index])
        if not match:
            continue
        start = _to_ms(*match.groups()[:4])
        end = _to_ms(*match.groups()[4:])
        body = " ".join(lines[time_index + 1 :]).strip()
        if body:
            segments.append(Segment(start, end, body))
    return segments


def parse_vtt(text: str) -> List[Segment]:
    segments: List[Segment] = []
    for block in re.split(r"\r?\n\s*\r?\n", (text or "").strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        time_index = next(
            (index for index, line in enumerate(lines) if "-->" in line),
            -1,
        )
        if time_index < 0:
            continue
        match = VTT_TIME_RE.search(lines[time_index])
        if not match:
            continue
        start = _to_ms(match.group(1) or "0", match.group(2), match.group(3), match.group(4))
        end = _to_ms(match.group(5) or "0", match.group(6), match.group(7), match.group(8))
        body = " ".join(lines[time_index + 1 :]).strip()
        if body:
            segments.append(Segment(start, end, body))
    return segments


def parse_subtitle_file(path: Path) -> List[Segment]:
    content = path.read_text(encoding="utf-8", errors="replace")
    suffix = path.suffix.lower()
    if suffix == ".vtt":
        return parse_vtt(content)
    if suffix in {".srt", ".txt"}:
        return parse_srt(content)
    raise ValueError(f"不支持的字幕格式：{suffix}")


def subtitle_title_is_english(title: str) -> bool:
    value = title or ""
    return bool(ENGLISH_TITLE_RE.search(value)) and not OTHER_LANGUAGE_RE.search(value)


def subtitle_title_is_other_language(title: str) -> bool:
    return bool(OTHER_LANGUAGE_RE.search(title or ""))


def looks_english(text: str, min_letters: int = 20) -> bool:
    plain = TAG_RE.sub(" ", text or "")
    letters = sum(1 for char in plain if char.isascii() and char.isalpha())
    cjk = len(CJK_RE.findall(plain))
    words = [word.lower() for word in WORD_RE.findall(plain)]
    stop_hits = ENGLISH_STOPWORDS.intersection(words)
    return (
        letters >= min_letters
        and cjk <= letters * 0.05
        and len(stop_hits) >= 2
    )


def clean_text(text: str) -> str:
    value = html.unescape(text or "")
    value = TAG_RE.sub("", value)
    value = ASS_TAG_RE.sub("", value)
    value = value.replace("\\N", " ").replace("\\n", " ")
    value = value.replace("\u200b", "").replace("\ufeff", "")
    value = value.strip(" -\u2013\u2014")
    ascii_letters = sum(1 for ch in value if ch.isascii() and ch.isalpha())
    if ascii_letters >= max(3, len(value) * 0.3):
        value = value.translate(FULLWIDTH_PUNCT)
    value = SPACE_RE.sub(" ", value)
    value = re.sub(r"\s+([,.;:!?])", r"\1", value)
    value = value.strip(" -\u2013\u2014")
    if not value or NOISE_RE.fullmatch(value):
        return ""
    return value


def _capitalize(text: str) -> str:
    for index, char in enumerate(text):
        if char.isalpha():
            return text[:index] + char.upper() + text[index + 1 :]
    return text


def _key(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", text).lower()


def dedupe_segments(segments: Sequence[Segment]) -> List[Segment]:
    """Collapse rolling captions and exact repeats produced by VTT/ASR."""
    result: List[Segment] = []
    for raw in sorted(segments, key=lambda item: (item.start, item.end)):
        text = clean_text(raw.text)
        if not text:
            continue
        current = Segment(raw.start, raw.end, text)
        if not result:
            result.append(current)
            continue
        previous = result[-1]
        previous_key = _key(previous.text)
        current_key = _key(current.text)
        if not current_key:
            continue
        if current_key == previous_key:
            previous.end = max(previous.end, current.end)
            continue
        if current_key in previous_key:
            continue
        if previous_key and previous_key in current_key and current.start <= previous.end + 250:
            result[-1] = current
            continue
        result.append(current)
    return result


def build_sentences(
    segments: Sequence[Segment],
    max_chars: int = 240,
    gap_ms: int = 1500,
) -> List[str]:
    """Join short ASR fragments into readable sentences."""
    sentences: List[str] = []
    buffer: List[str] = []
    buffer_len = 0
    previous_end: Optional[int] = None

    def flush() -> None:
        nonlocal buffer, buffer_len
        if buffer:
            sentence = SPACE_RE.sub(" ", " ".join(buffer)).strip()
            if sentence:
                sentences.append(_capitalize(sentence))
        buffer = []
        buffer_len = 0

    for segment in segments:
        text = clean_text(segment.text)
        if not text:
            continue
        if (
            previous_end is not None
            and segment.start - previous_end > gap_ms
            and buffer
        ):
            flush()
        buffer.append(text)
        buffer_len += len(text)
        previous_end = segment.end
        if SENTENCE_END_RE.search(text) or buffer_len >= max_chars:
            flush()
    flush()
    return sentences


def segments_to_paragraphs(
    segments: Sequence[Segment],
    sentences_per_paragraph: int = 4,
    max_chars: int = 240,
    gap_ms: int = 1500,
) -> str:
    sentences = build_sentences(segments, max_chars=max_chars, gap_ms=gap_ms)
    paragraphs = [
        " ".join(sentences[index : index + sentences_per_paragraph])
        for index in range(0, len(sentences), max(1, sentences_per_paragraph))
    ]
    return "\n\n".join(paragraphs)


def offset_segments(segments: Iterable[Segment], offset_ms: int) -> List[Segment]:
    return [segment.shifted(offset_ms) for segment in segments]


def _srt_timestamp(ms: int) -> str:
    total_seconds, milliseconds = divmod(max(0, int(ms)), 1000)
    minutes, seconds = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def segments_to_srt(segments: Sequence[Segment]) -> str:
    blocks = []
    for index, segment in enumerate(segments, 1):
        blocks.append(
            f"{index}\n"
            f"{_srt_timestamp(segment.start)} --> {_srt_timestamp(segment.end)}\n"
            f"{segment.text}\n"
        )
    return "\n".join(blocks)
