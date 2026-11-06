"""
MarketMind news: real headlines for a stock from Google News' public RSS feed.

No scoring and no summarising: headlines are shown exactly as published, with their source and time, so the
page never presents an invented "catalyst". Parsing is a pure function (unit-tested, no network).
"""

from __future__ import annotations

import logging
import re
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional

log = logging.getLogger("marketmind.news")

RSS_URL = "https://news.google.com/rss/search"
CACHE_SECONDS = 600
MAX_ITEMS = 6
MAX_BYTES = 400_000
_URL_OK = re.compile(r"^https?://", re.I)


def parse_rss(xml_text: str, limit: int = MAX_ITEMS) -> List[Dict[str, Any]]:
    """RSS text -> [{title, source, url, ts}], newest first. Hostile or broken XML yields []."""
    if not xml_text or len(xml_text) > MAX_BYTES:
        return []
    head = xml_text[:2000].upper()
    if "<!DOCTYPE" in head or "<!ENTITY" in xml_text.upper():  # blocks entity-expansion tricks
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    out: List[Dict[str, Any]] = []
    seen = set()
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not _URL_OK.match(link):
            continue
        source = ""
        src_el = item.find("source")
        if src_el is not None and (src_el.text or "").strip():
            source = src_el.text.strip()
        if " - " in title:  # Google appends "- Publisher" to the title
            head_t, _, tail = title.rpartition(" - ")
            if head_t and (not source or tail.strip() == source):
                title, source = head_t.strip(), source or tail.strip()
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        ts: Optional[int] = None
        pub = (item.findtext("pubDate") or "").strip()
        if pub:
            try:
                ts = int(parsedate_to_datetime(pub).timestamp())
            except (TypeError, ValueError):
                ts = None
        out.append({"title": title[:220], "source": source[:60], "url": link, "ts": ts})
    out.sort(key=lambda x: x["ts"] or 0, reverse=True)
    return out[:limit]


class NewsFetcher:
    def __init__(self, user_agent: str) -> None:
        self._ua = user_agent
        self._client: Any = None
        self._cache: Dict[str, tuple] = {}
        self.last_error = ""

    async def _ensure(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers={"User-Agent": self._ua})
        return self._client

    async def headlines(self, symbol: str, name: str) -> List[Dict[str, Any]]:
        key = symbol.upper()
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
        label = (name or symbol).strip()[:60]
        query = f'"{label}" OR "{symbol}" share price when:14d'
        client = await self._ensure()
        try:
            resp = await client.get(RSS_URL, params={"q": query, "hl": "en-IN", "gl": "IN", "ceid": "IN:en"})
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}")
            items = parse_rss(resp.text)
            self._cache[key] = (time.time(), items)
            self.last_error = ""
            return items
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)[:100]
            log.info("news for %s unavailable: %s", symbol, self.last_error)
            return hit[1] if hit else []

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()