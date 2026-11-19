"""
worker/adapters/reddit.py — Reddit RSS Source Adapter
=====================================================
Ported from Devign-radar/worker.py with enhanced fault isolation:
  - Configurable subreddit feeds and keyword filters
  - feedparser RSS/Atom parsing (with stdlib XML/HTTP fallback when absent)
  - ETag / If-Modified-Since caching (HTTP 304 skipped)
  - Canonical Reddit permalink normalization (dedup key)
  - HTTP 429 rate-limit detection with per-feed exponential backoff
  - Graceful handling of unavailable feeds
"""

import calendar
import email.utils
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Any, Callable, Optional

try:
    import feedparser  # type: ignore
except ImportError:  # pragma: no cover
    feedparser = None

from ..net_guard import SSRFBlockedError, safe_fetch_bytes
from .base import CanonicalSignal, SourceAdapter

ATOM_NS = "{http://www.w3.org/2005/Atom}"


def normalize_url(url: str) -> str:
    """
    Return a canonical Reddit permalink.
    - Strips query params (?utm_source, ?ref, etc.)
    - Normalises host to www.reddit.com
    - Removes trailing slash
    - Lowercases path
    """
    if not url:
        return ""
    try:
        p = urllib.parse.urlparse(url.strip())
        host = "www.reddit.com"
        clean_path = p.path.rstrip("/").lower()
        return f"https://{host}{clean_path}"
    except Exception:
        return url.strip().rstrip("/")


def strip_html(raw: str) -> str:
    if not raw:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw)).strip()


def extract_utc(entry: dict[str, Any]) -> int:
    """Extract Unix UTC timestamp from feedparser or fallback entry."""
    pp = entry.get("published_parsed") or entry.get("updated_parsed")
    if pp:
        try:
            return int(calendar.timegm(pp))
        except Exception:
            pass
    raw_date = entry.get("published") or entry.get("updated")
    if isinstance(raw_date, str) and raw_date.strip():
        try:
            dt = email.utils.parsedate_to_datetime(raw_date.strip())
            return int(dt.timestamp())
        except Exception:
            try:
                iso = raw_date.strip().replace("Z", "+00:00")
                return int(datetime.fromisoformat(iso).timestamp())
            except Exception:
                pass
    return int(time.time())


def extract_subreddit(url: str) -> str:
    if "/r/" in url:
        return url.split("/r/", 1)[1].split("/", 1)[0]
    return url


def _parse_xml_fallback(xml_bytes: bytes) -> list[dict[str, Any]]:
    """Minimal Atom/RSS XML parser used only if feedparser is unavailable."""
    entries: list[dict[str, Any]] = []
    root = ET.fromstring(xml_bytes)

    for node in root.findall(f"{ATOM_NS}entry"):
        link_el = node.find(f"{ATOM_NS}link")
        link = link_el.attrib.get("href", "") if link_el is not None else ""
        title_el = node.find(f"{ATOM_NS}title")
        content_el = node.find(f"{ATOM_NS}content")
        summary_el = node.find(f"{ATOM_NS}summary")
        updated_el = node.find(f"{ATOM_NS}updated") or node.find(f"{ATOM_NS}published")
        author_el = node.find(f"{ATOM_NS}author/{ATOM_NS}name")
        body = ""
        if content_el is not None and content_el.text:
            body = content_el.text
        elif summary_el is not None and summary_el.text:
            body = summary_el.text
        entries.append({
            "link": link,
            "title": (title_el.text or "") if title_el is not None else "",
            "summary": body,
            "published": (updated_el.text or "") if updated_el is not None else "",
            "author": (author_el.text or "") if author_el is not None else "",
        })

    if entries:
        return entries

    for item in root.findall(".//item"):
        title_el = item.find("title")
        link_el = item.find("link")
        desc_el = item.find("description")
        pub_el = item.find("pubDate")
        author_el = item.find("author")
        entries.append({
            "link": (link_el.text or "") if link_el is not None else "",
            "title": (title_el.text or "") if title_el is not None else "",
            "summary": (desc_el.text or "") if desc_el is not None else "",
            "published": (pub_el.text or "") if pub_el is not None else "",
            "author": (author_el.text or "") if author_el is not None else "",
        })
    return entries


class RedditAdapter(SourceAdapter):
    USER_AGENT = "SONARS-RedditAdapter/1.0 (+https://devign.digital)"

    def __init__(
        self,
        config: dict[str, Any],
        log_fn=None,
        *,
        allow_local_test_feeds: bool = False,
        resolver: Optional[Callable[[str, int], list[str]]] = None,
    ) -> None:
        super().__init__(config, log_fn=log_fn)
        self._allow_local_test_feeds = bool(allow_local_test_feeds)
        self._resolver = resolver
        self._etag_cache: dict[str, dict[str, str]] = {}
        self._backoff_until: dict[str, float] = {}
        self._backoff_seconds: dict[str, int] = {}

    def get_source_type(self) -> str:
        return "reddit"

    def health_check(self) -> bool:
        feeds = self.config.get("feeds", [])
        keywords = self.config.get("keywords", [])
        return isinstance(feeds, list) and len(feeds) > 0 and isinstance(keywords, list)

    def _register_429_backoff(self, url: str, retry_after: Any = None) -> int:
        base_delay = max(120, int(self.config.get("interval", 120)) * 2)
        prev = self._backoff_seconds.get(url, 0)
        delay = min(3600, base_delay if prev == 0 else prev * 2)
        if retry_after is not None:
            try:
                delay = max(delay, min(3600, int(float(retry_after))))
            except (ValueError, TypeError):
                pass
        self._backoff_seconds[url] = delay
        self._backoff_until[url] = time.time() + delay
        return delay

    def _clear_backoff(self, url: str) -> None:
        self._backoff_seconds.pop(url, None)
        self._backoff_until.pop(url, None)

    def fetch_feed(self, url: str) -> dict[str, Any]:
        headers = {"User-Agent": self.USER_AGENT}
        cache = self._etag_cache.get(url, {})
        if cache.get("etag"):
            headers["If-None-Match"] = cache["etag"]
        if cache.get("modified"):
            headers["If-Modified-Since"] = cache["modified"]

        resp = safe_fetch_bytes(
            url,
            headers=headers,
            timeout=15.0,
            allow_private_for_test=self._allow_local_test_feeds,
            resolver=self._resolver,
        )
        status = int(resp.get("status", 200))
        resp_headers = resp.get("headers", {})
        etag = resp_headers.get("etag")
        modified = resp_headers.get("last-modified")
        if etag:
            self._etag_cache.setdefault(url, {})["etag"] = etag
        if modified:
            self._etag_cache.setdefault(url, {})["modified"] = modified

        if status == 304:
            return {"status": 304, "entries": [], "retry_after": None}

        if status >= 400:
            return {
                "status": status,
                "entries": [],
                "retry_after": resp_headers.get("retry-after"),
            }

        raw = resp.get("body", b"")
        if feedparser is not None:
            parsed = feedparser.parse(raw)
            entries = list(getattr(parsed, "entries", []) or [])
        else:
            entries = _parse_xml_fallback(raw)

        return {
            "status": status,
            "entries": entries,
            "retry_after": resp_headers.get("retry-after"),
        }

    def scan_feed(
        self, url: str, keywords: list[str], seen_ids: set[str]
    ) -> tuple[list[CanonicalSignal], int, int, int]:
        signals: list[CanonicalSignal] = []
        checked = dupes = errors = 0
        sub = extract_subreddit(url)

        now = time.time()
        cooldown_until = self._backoff_until.get(url, 0)
        if now < cooldown_until:
            remaining = int(cooldown_until - now)
            self.log("WARN", f"r/{sub} — in 429 cooldown ({remaining}s remaining); skipping")
            return [], 0, 0, 0

        try:
            feed = self.fetch_feed(url)
        except SSRFBlockedError as exc:
            self.log("WARN", f"Feed blocked by SSRF guard r/{sub}: {exc}")
            return [], 0, 0, 1
        except Exception as exc:
            self.log("ERROR", f"Feed unavailable r/{sub}: {exc}")
            return [], 0, 0, 1

        status = int(feed.get("status", 200))
        if status == 304:
            self._clear_backoff(url)
            self.log("FEED", f"r/{sub} — 304 Not Modified (cached)")
            return [], 0, 0, 0
        if status == 429:
            delay = self._register_429_backoff(url, feed.get("retry_after"))
            self.log("WARN", f"r/{sub} — HTTP 429 Rate Limited; backing off for {delay}s")
            return [], 0, 0, 1
        if status >= 400:
            self.log("WARN", f"r/{sub} — HTTP {status} returned; feed skipped")
            return [], 0, 0, 1

        self._clear_backoff(url)
        entries = feed.get("entries", [])
        self.log("FEED", f"r/{sub} — {len(entries)} posts")

        for entry in entries:
            checked += 1
            raw_link = entry.get("link", "")
            canonical = normalize_url(raw_link)
            if not canonical:
                continue

            if canonical in seen_ids:
                dupes += 1
                self.log("DEDUP", f"Skipping known post: {entry.get('title', '')[:55]}")
                continue
            seen_ids.add(canonical)

            title = str(entry.get("title", "") or "").strip()
            content_raw = str(entry.get("summary", "") or "")
            content = strip_html(content_raw)[:1200]
            published_utc = extract_utc(entry)
            author = str(entry.get("author", "") or "").strip()

            search_text = f"{title} {content}".lower()
            matched_kw = next((kw for kw in keywords if kw.lower() in search_text), None)
            if not matched_kw:
                continue

            signals.append(
                CanonicalSignal(
                    source_type="reddit",
                    source_entity_id=canonical,
                    source_channel=f"r/{sub}",
                    entity_name=author or f"redditor@{sub}",
                    title=title,
                    content=content,
                    url=canonical,
                    matched_keyword=matched_kw,
                    published_utc=published_utc,
                    raw_payload={
                        "source_url": url,
                        "raw_link": raw_link,
                        "subreddit": f"r/{sub}",
                        "author": author,
                        "published_utc": published_utc,
                        "matched_keyword": matched_kw,
                        "summary_excerpt": content[:600],
                    },
                )
            )

        return signals, checked, dupes, errors

    def poll(self, seen_ids: set[str]) -> tuple[list[CanonicalSignal], dict[str, int]]:
        feeds = self.config.get("feeds", [])
        keywords = self.config.get("keywords", [])
        all_signals: list[CanonicalSignal] = []
        total_checked = total_dupes = total_errors = 0

        for feed_url in feeds:
            sigs, checked, dupes, errs = self.scan_feed(feed_url, keywords, seen_ids)
            all_signals.extend(sigs)
            total_checked += checked
            total_dupes += dupes
            total_errors += errs

        return all_signals, {
            "posts_checked": total_checked,
            "dupes_skipped": total_dupes,
            "errors": total_errors,
        }
