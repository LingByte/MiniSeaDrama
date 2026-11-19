"""Cookie input normalisation for ShortFlix authentication."""

from __future__ import annotations

import json
import re
from typing import List, Optional

COOKIE_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$")
SHORTFLIX_DOMAIN_SUFFIX = ".shortflix.net"


def _valid_pair(name: str, value: str) -> bool:
    return bool(
        COOKIE_NAME_RE.fullmatch(name)
        and value
        and "\r" not in value
        and "\n" not in value
        and ";" not in value
    )


def _from_json(text: str) -> Optional[str]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    items = payload if isinstance(payload, list) else payload.get("cookies")
    if not isinstance(items, list):
        return None
    pairs: List[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        domain = str(item.get("domain") or "").lstrip(".").lower()
        if domain and domain != "shortflix.net" and not domain.endswith(
            SHORTFLIX_DOMAIN_SUFFIX
        ):
            continue
        name = str(item.get("name") or "")
        value = str(item.get("value") or "")
        if _valid_pair(name, value):
            pairs.append(f"{name}={value}")
    return "; ".join(pairs) if pairs else None


def _from_netscape(text: str) -> Optional[str]:
    pairs: List[str] = []
    matched = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        fields = stripped.split("\t")
        if len(fields) < 7:
            continue
        domain, _flag, _path, _secure, _expires, name, value = fields[:7]
        domain = domain.lstrip(".").lower()
        if domain != "shortflix.net" and not domain.endswith(
            SHORTFLIX_DOMAIN_SUFFIX
        ):
            continue
        matched = True
        if _valid_pair(name, value):
            pairs.append(f"{name}={value}")
    if matched:
        return "; ".join(pairs)
    return None


def parse_cookie_header(raw: str) -> str:
    """Accept a raw Cookie header, a Netscape cookies.txt or extension JSON."""
    text = (raw or "").strip()
    if not text:
        return ""

    if text.startswith(("[", "{")):
        parsed = _from_json(text)
        if parsed is not None:
            return parsed

    if "\t" in text:
        parsed = _from_netscape(text)
        if parsed is not None:
            return parsed

    if text.lower().startswith("cookie:"):
        text = text.split(":", 1)[1].strip()

    pairs: List[str] = []
    for chunk in text.split(";"):
        name, _, value = chunk.strip().partition("=")
        if _valid_pair(name.strip(), value.strip()):
            pairs.append(f"{name.strip()}={value.strip()}")
    return "; ".join(pairs)
